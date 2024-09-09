# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0

import json
import os
from opensearchpy import OpenSearch, RequestsHttpConnection
from requests_aws4auth import AWS4Auth
import boto3
import botocore
import time

region = os.environ['REGION']
client = boto3.client('opensearchserverless', region_name = region)
service = 'aoss'
credentials = boto3.Session().get_credentials()
awsauth = AWS4Auth(credentials.access_key, credentials.secret_key, region, service, session_token=credentials.token)

def on_event(event, context):

    print("Received event: " + json.dumps(event, indent=2))
    request_type = event['RequestType']
    if request_type == 'Create': 
        print("Creating domain")
        os_url = os.environ['DOMAINURL']
        index_name = os.environ['INDEX']

        mapping = {
            'settings': {
                'index': {
                    'knn': True  # Enable k-NN search for this index
                }
            },
            'mappings': {
                'properties': {
                    'embedding': {  # k-NN vector field
                        'type': 'knn_vector',
                        'dimension': 1024 # Dimension of the vector
                    },
                    'passage': {
                        'type': 'text'
                    },
                    'doc_id': {
                        'type': 'keyword'
                    }
                }
            }
        }

        client = OpenSearch(
            hosts=f"{os_url}:443",
            http_auth=awsauth,
            use_ssl=True,
            verify_certs=True,
            connection_class=RequestsHttpConnection,
            timeout=300
        )

        print(f"Checking domain {os_url}/{index_name}")
        if client.indices.exists(index=index_name):
            print('Index already exists!')
        else:
            client.indices.create(
                index = index_name,
                body = mapping
            )
            print(f'Index created')
        return { 'PhysicalResourceId': index_name}
