# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0

import boto3
from botocore.exceptions import ClientError
import os
from datasets import load_dataset
from datasets import Dataset
from ragas.metrics import (
    context_precision,
    context_recall,
)
from ragas.metrics.critique import harmfulness
from ragas.llms import LangchainLLMWrapper
from ragas import evaluate
from ragas.embeddings import LangchainEmbeddingsWrapper
from ragas.testset.extractor import KeyphraseExtractor
from ragas.testset import TestsetGenerator
from ragas.testset.evolutions import simple, reasoning, multi_context
from langchain.text_splitter import TokenTextSplitter
from ragas.testset.docstore import InMemoryDocumentStore
from langchain_aws import ChatBedrock
from langchain_community.embeddings import BedrockEmbeddings
from langchain_community.document_loaders import DirectoryLoader
from langchain_community.document_loaders.s3_directory import S3DirectoryLoader
from langchain_core.output_parsers import StrOutputParser
from langchain_core.messages import HumanMessage, SystemMessage

# Constants
BEDROCK_TEXT_GENERATION_MODEL = 'anthropic.claude-3-sonnet-20240229-v1:0'
BEDROCK_APP_GENERATION_MODEL = 'anthropic.claude-3-haiku-20240307-v1:0'
BEDROCK_EMBEDDING_MODEL = 'amazon.titan-embed-text-v2:0'
CREDENTIALS = boto3.Session().get_credentials()
REGION = boto3.Session().region_name
BEDROCK_CLIENT = boto3.client(
    service_name='bedrock-runtime',
    region_name=REGION,
)
EMBEDDINGS = BedrockEmbeddings(model_id=BEDROCK_EMBEDDING_MODEL, client=BEDROCK_CLIENT)
LLM = ChatBedrock(
    model_id=BEDROCK_TEXT_GENERATION_MODEL,
    model_kwargs = {"temperature": 0.5, "max_tokens": 2048}
)
LLM_APP = ChatBedrock(
    model_id=BEDROCK_APP_GENERATION_MODEL,
    model_kwargs = {"temperature": 0.5, "max_tokens": 2048}
)
BUCKET = os.environ['BUCKET']
PREFIX = os.environ['DOC_PATH']
CW_CLIENT = boto3.client('cloudwatch',
                         region_name=REGION)

def call_bedrock_text_generation_model(ragllm, query, context):
    messages = [
        SystemMessage(content="Answer based on provided context"),
        HumanMessage(content=f"{query}\n\nHere's the context: {context}"),
    ]
    parser = StrOutputParser()
    chain = ragllm | parser

    try:
        llm_result = chain.invoke(messages)
        return llm_result
    except Exception as e:
        print(f"Error in chain: {e}")
        return "Unknown error"

def get_answer(q, c):
    return call_bedrock_text_generation_model(LLM_APP, q, c)

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

# list of metrics we're going to use
metrics = [
    context_recall,
    context_precision,
    harmfulness,
]

print(f"Loading docs from s3://{BUCKET}/{PREFIX}")
loader = S3DirectoryLoader(bucket = BUCKET, prefix = PREFIX, region_name = REGION)
documents = loader.load()

wrapped_llm = LangchainLLMWrapper(langchain_llm=LLM)
wrapped_embeddings = LangchainEmbeddingsWrapper(EMBEDDINGS)

splitter = TokenTextSplitter(chunk_size=1000, chunk_overlap=100)
keyphrase_extractor = KeyphraseExtractor(llm=wrapped_llm)

docstore = InMemoryDocumentStore(
    splitter=splitter,
    embeddings=wrapped_embeddings,
    extractor=keyphrase_extractor,
)

test_generator = TestsetGenerator(
    generator_llm=wrapped_llm,
    critic_llm=wrapped_llm,
    embeddings=wrapped_embeddings,
    docstore=docstore,
)

distributions = {simple: 0.5, reasoning: 0.25, multi_context: 0.25}

print("Generating test set")
testset = test_generator.generate_with_langchain_docs(
    documents=documents, test_size=100, distributions=distributions
)

test_df = testset.to_pandas()

print("Adding answer column")
test_df['answer'] = test_df.apply(lambda x: get_answer(x['question'], x['contexts']), axis=1)

test_dataset = Dataset.from_pandas(test_df)

print("Starting evaluation")
result = evaluate(
    test_dataset,
    metrics=metrics,
    llm=LLM,
    embeddings=EMBEDDINGS,
)

context_recall = result['context_recall']
context_precision = result['context_precision']
harmfulness = result['harmfulness']
print(f"Recording output in CloudWatch: {context_recall}, {context_precision}, {harmfulness}")
put_cw_metric(CW_CLIENT, "ragas", "context_recall", context_recall)
put_cw_metric(CW_CLIENT, "ragas", "context_precision", context_precision)
put_cw_metric(CW_CLIENT, "ragas", "harmfulness", harmfulness)
