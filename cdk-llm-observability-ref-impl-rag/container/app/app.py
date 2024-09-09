# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0

# Core Python imports
import traceback
import os
import json
import uuid
import logging

# Streamlit imports
import streamlit as st

# AWS imports
import boto3
from botocore.exceptions import ClientError
from requests_aws4auth import AWS4Auth
from opensearchpy import RequestsHttpConnection

# Langchain imports
from langchain_community.vectorstores import OpenSearchVectorSearch
from langchain_community.embeddings import BedrockEmbeddings
from langchain_aws import ChatBedrock
from langchain_core.messages import HumanMessage, SystemMessage
from langchain_core.output_parsers import StrOutputParser

# OpenLLMetry imports
from traceloop.sdk import Traceloop
from traceloop.sdk.decorators import workflow

# MLFlow imports
import mlflow

# Logging configuration
logging.getLogger().setLevel(logging.INFO)
logger = logging.getLogger()

# Configure OpenLLMetry
logger.info(f"Traceloop URL: {os.environ['TRACELOOP_BASE_URL']}")
Traceloop.init(app_name="llm-app-1")

# Bedrock and OpenSearch static configuration
BEDROCK_TEXT_GENERATION_MODEL = 'anthropic.claude-3-haiku-20240307-v1:0'
BEDROCK_EMBEDDING_MODEL = 'amazon.titan-embed-text-v2:0'
OPENSEARCH_DOMAIN_ENDPOINT = os.environ['OPENSEARCH_ENDPOINT']
OPENSEARCH_INDEX = os.environ['OPENSEARCH_INDEX']
MLFLOW_TRACKING_ARN = os.environ['MLFLOW_TRACKING_ARN']
CREDENTIALS = boto3.Session().get_credentials()
REGION = boto3.Session().region_name
BEDROCK_CLIENT = boto3.client(
    service_name='bedrock-runtime',
    region_name=REGION,
)
AWSAUTH = AWS4Auth(region=REGION, service='aoss', refreshable_credentials=CREDENTIALS)
EMBEDDINGS = BedrockEmbeddings(model_id=BEDROCK_EMBEDDING_MODEL, client=BEDROCK_CLIENT)
LLM = ChatBedrock(
    model_id=BEDROCK_TEXT_GENERATION_MODEL,
    model_kwargs = {"temperature": 0.5, "max_tokens": 8191}
)
CW_CLIENT = boto3.client('cloudwatch',
                         region_name=REGION)
mlflow.set_tracking_uri(MLFLOW_TRACKING_ARN)
print(f"Setting MLFlow tracking ARN to {MLFLOW_TRACKING_ARN}")

if 'chatfeedback' not in st.session_state:
    st.session_state.chatfeedback = None
if 'ragfeedback' not in st.session_state:
    st.session_state.ragfeedback = None

def put_cw_metric(cwclient, ns, name, score):
    try:
        cwclient.put_metric_data(
            Namespace=ns,
            MetricData=[
                {
                    'MetricName': name,
                    'Value': score,
                    'Unit': 'None',
                    'StorageResolution': 1
                },
            ]
        )
    except ClientError as err:
        print(err.response['Error']['Code'], err.response['Error']['Message'])
        raise

def handle_feedback_chat():
    if st.session_state.chatfeedback is not None:
        with mlflow.start_run() as run:
            print(f"Logging user feedback: {st.session_state.chatfeedback}")
            mlflow.log_metric("UserFeedback", st.session_state.chatfeedback)
            mlflow.log_param("Model", BEDROCK_TEXT_GENERATION_MODEL)
            mlflow.log_param("Input", st.session_state.chat)
            mlflow.log_param("Output", st.session_state.chat_answer)
            put_cw_metric(CW_CLIENT, "chatfeedback", "rating", st.session_state.chatfeedback)
    st.session_state.chatfeedback = None
def handle_feedback_rag():
    if st.session_state.ragfeedback is not None:
        with mlflow.start_run() as run:
            print(f"Logging user feedback: {st.session_state.ragfeedback}")
            mlflow.log_metric("UserFeedback", st.session_state.ragfeedback)
            mlflow.log_param("Model", BEDROCK_TEXT_GENERATION_MODEL)
            mlflow.log_param("EmbeddingModel", BEDROCK_EMBEDDING_MODEL)
            mlflow.log_param("Input", st.session_state.query)
            mlflow.log_param("Output", st.session_state.rag_answer)
            mlflow.log_param("Context", st.session_state.context)
            put_cw_metric(CW_CLIENT, "ragfeedback", "rating", st.session_state.ragfeedback)
    st.session_state.ragfeedback = None

# Function to do vector search and get context from opensearch. Returns list of documents
@workflow(name="rag_context")
def get_context_from_opensearch(query, opensearch_domain_endpoint, opensearch_index):
    opensearch_endpoint = opensearch_domain_endpoint
    docsearch = OpenSearchVectorSearch(
        index_name=opensearch_index,
        embedding_function=EMBEDDINGS,
        opensearch_url=opensearch_endpoint,
        http_auth=AWSAUTH,
        timeout=300,
        use_ssl=True,
        verify_certs=True,
        connection_class=RequestsHttpConnection,
    )

    docs_with_scores = docsearch.similarity_search_with_score(query, k=3, vector_field="embedding", text_field="passage")
    docs = [doc[0] for doc in docs_with_scores]
    logger.info(f"docs received from opensearch:\n{docs}")
    return docs # return list of matching docs

# regular chat
@workflow(name="chat_tab")
def call_bedrock_text_generation_model(query):
    messages = [
        SystemMessage(content="Respond concisely"),
        HumanMessage(content=query),
    ]
    parser = StrOutputParser()
    chain = LLM | parser

    try:
        llm_result = chain.invoke(messages)
        return llm_result
    except Exception as e:
        logger.warn(f"Error in chain: {e}")
        traceback.print_exc()
        return "Unknown error"

# Function to combine the context from vector search, combine with question and query bedrock
@workflow(name="rag_tab")
def call_bedrock_text_generation_model_rag(query, context):

    messages = [
        SystemMessage(content="Answer based on provided context"),
        HumanMessage(content=f"{query}\n\nHere's the context: {context}"),
    ]
    parser = StrOutputParser()
    chain = LLM | parser

    try:
        llm_result = chain.invoke(messages)
        return llm_result
    except Exception as e:
        logger.warn(f"Error in chain: {e}")
        traceback.print_exc()
        return "Unknown error"

conversation_id = uuid.uuid4()
st.session_state.id = conversation_id
st.set_page_config(page_title="GenAI Full Stack Solution")

tabChat, tabRag = st.tabs(["Chat", "RAG"])

with tabChat:
    st.header('Chat', divider='rainbow')
    input_chat = st.text_input('How can I help?', key='chatinput')
    st.session_state.chat = input_chat
    chat_button = st.button('Go', type="primary")
    if chat_button:
        with st.spinner('Thinking...'):
            answer = call_bedrock_text_generation_model(st.session_state.chat)
            st.session_state.chat_answer = answer
            st.write(answer)
            st.feedback(options="thumbs", key="chatfeedback", on_change=handle_feedback_chat)
            

with tabRag:
    st.header('RAG', divider='rainbow')
    input_rag = st.text_input('Ask me about your reference documents', key='raginput')
    st.session_state.query =input_rag
    rag_button = st.button('Answer', type="primary")
    if rag_button:
        with st.spinner('Searching for similar documents for context...'):
            context = get_context_from_opensearch(st.session_state.query, OPENSEARCH_DOMAIN_ENDPOINT, OPENSEARCH_INDEX)
            st.session_state.context = context
            st.success(f"Found {str(len(context))} similar documents")
        with st.spinner('Generating Answer...'):
            answer = call_bedrock_text_generation_model_rag(st.session_state.query, st.session_state.context)
            st.session_state.rag_answer = answer
            st.write(answer)
            st.feedback(options="thumbs", key="ragfeedback", on_change=handle_feedback_rag)
            st.success(f"Conversation ID is {conversation_id}")

