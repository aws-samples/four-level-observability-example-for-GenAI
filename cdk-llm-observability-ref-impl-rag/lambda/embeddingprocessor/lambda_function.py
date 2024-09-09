# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0

import traceback
import json
import boto3
from opensearchpy.helpers import bulk
from opensearchpy import OpenSearch, RequestsHttpConnection
from requests_aws4auth import AWS4Auth
import os
import uuid
import botocore
import time

"""
Example input:

{
  "Items": [
    {
      "paragraph": "93",
      "content": "Customers are responsible for making their own independent assessment of the information in this document. This document: (a) is for informational purposes only, (b) represents current AWS product offerings and practices, which are subject to change without notice, and (c) does not create any commitments or assurances from AWS and its affiliates, suppliers or licensors. AWS products or services are provided \"as is\" without warranties, representations, or conditions of any kind, whether express or implied. The responsibilities and liabilities of AWS to its customers are controlled by AWS agreements, and this document is not part of, nor does it modify, any agreement between AWS and its customers."
    },
    {
      "paragraph": "94",
      "content": "© 2023 Amazon Web Services, Inc. or its affiliates. All rights reserved."
    },
    {
      "paragraph": "95",
      "content": "For the latest AWS terminology, see the AWS glossary in the AWS Glossary Reference."
    }
  ]
}

"""

region = os.environ['REGION']
osclient = boto3.client('opensearchserverless', region_name = region)
service = 'aoss'
credentials = boto3.Session().get_credentials()
awsauth = AWS4Auth(credentials.access_key, credentials.secret_key, region, service, session_token=credentials.token)

def get_embedding(text, modelId, client):
    accept = 'application/json'
    contentType = 'application/json'
    inp = json.dumps({"inputText": text})
    response = client.invoke_model(body=inp, modelId=modelId, accept=accept, contentType=contentType)
    response_body = json.loads(response.get('body').read())
    embedding = response_body.get('embedding')
    return embedding


def lambda_handler(event, context):

    print("Received event: " + json.dumps(event, indent=2))
    os_url = os.environ['DOMAINURL']
    index_name = os.environ['INDEX']

    bedrock = boto3.client(
        service_name='bedrock-runtime',
        region_name=region,
    )
    embedding_model = 'amazon.titan-embed-text-v2:0'

    fhclient = boto3.client('firehose')

    try:
        opensearch = OpenSearch(
            hosts=f"{os_url}:443",
            http_auth=awsauth,
            use_ssl=True,
            verify_certs=True,
            connection_class=RequestsHttpConnection,
            timeout=300
        )

        requests = []
        for item in event['Items']:
            print(f"Working on item {item}")
            content = item['content']
            embedding = get_embedding(content, embedding_model, bedrock)
            _id = str(uuid.uuid4())
            request = {
                "_op_type": "index",
                "_index": index_name,
                "embedding": embedding,
                "passage": content,
                "doc_id": _id,
            }
            requests.append(request)
        bulk(opensearch, requests)
        opensearch.indices.refresh(index=index_name)
        return { "Message": "Success "}
    except Exception as e:
        trc = traceback.format_exc()
        print(trc)
        return { "Message": "Failure"}
