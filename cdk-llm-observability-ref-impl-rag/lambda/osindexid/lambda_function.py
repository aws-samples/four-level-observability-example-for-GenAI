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
    if request_type == 'Create' or request_type == 'Update':
        print("Getting index ID")
        os_url = os.environ['DOMAINURL']
        index_name = os.environ['INDEX']

        client = OpenSearch(
            hosts=f"{os_url}:443",
            http_auth=awsauth,
            use_ssl=True,
            verify_certs=True,
            connection_class=RequestsHttpConnection,
            timeout=300
        )

        print(f"Checking domain {os_url}/{index_name}")
        index_id = ''
        if client.indices.exists(index=index_name):
            print('Index exists!')
            index_data = client.indices.get(index=index_name)
            index_id = index_data['embeddings']['settings']['index']['uuid']
        else:
            print(f'Index does not exist')
        return { 
            'PhysicalResourceId': index_name,
            'Data': {
                'IndexId': index_id
            },
        }
