#!/usr/bin/env node

// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { Aspects } from 'aws-cdk-lib';
import { NagSuppressions } from 'cdk-nag';
import { AwsSolutionsChecks } from 'cdk-nag'; 
import { CdkLlmObservabilityRefImplRagStack } from '../lib/cdk-llm-observability-ref-impl-rag-stack';

const app = new cdk.App();
const stack = new CdkLlmObservabilityRefImplRagStack(app, 'CdkLlmObservabilityRefImplRagStack', {
  env: { region: 'us-east-1' }
});

Aspects.of(app).add(new AwsSolutionsChecks({ verbose:true }));

NagSuppressions.addStackSuppressions(stack, [
    { id: 'AwsSolutions-IAM4', reason: 'The remediation of using AWS Managed Policies - which may not restrict resource access in relation to the permissions granted - is deemed out of scope for AWS Samples projects produced by the AGS Solutions Architecture Organization.' },
    { id: 'AwsSolutions-IAM5', reason: 'IAM5 remediation includes defining least privelage granular scope of permissions such that wildcards are not used. This CDK project is configured such that resources defined therein do not perform actions outside the scope of the project\'s intended purpose. The only oustanding risk is that an actor with credentials to the environment these resources are deployed within could cause malfeasance, which is unlikely.' },
    { id: 'CdkNagValidationFailure', reason: 'EcrDockerEndpoint and KmsEndpoint resources reference an instrinsic function. This suppression removes the warning raised as a result.' },
    { id: 'AwsSolutions-L1', reason: 'L1 remediation includes configuring non-container Lambda function runtime as the latest for the language used. Publishing team will upgrade the function code to use the last when the current version approached end of life.' },
    { id: 'AwsSolutions-SMG4', reason: 'Secrets Manager secret rotation deemed unnecessary for this project.' },
    { id: 'AwsSolutions-RDS3', reason: 'Multi-AZ Support unnecessary for PoC Project. End-users may change this if the project is productized.' },
    { id: 'AwsSolutions-RDS10', reason: 'Deletion Protection intentionally disabled for easy destruction of Resources created by this AWS Samples Project.' },
    { id: 'AwsSolutions-RDS11', reason: 'RDS using default port. This can be changed by end-users if this project is used for a production workload.' },
    { id: 'AwsSolutions-KDF1', reason: 'Server-side encryption unnecessary for this project unless end-users are in an industry which must meet strict regulatory requirements. Can be configured for Firehose delivery stream assets if necessary.' },
    { id: 'AwsSolutions-ELB2', reason: 'Access Logs disabled intentionally to reduce the footprint of this project.' },
    { id: 'AwsSolutions-ECS2', reason: 'Using secrets to inject via Systems Manager Parameter Store or Secrets Manager out of scope for PoC. Can be configured by end-user if this is a requirement.',},
    { id: 'AwsSolutions-CFR1', reason: 'To remove warning that listener was redefined.' },
    { id: 'AwsSolutions-CFR2', reason: 'To remove warning that WAF is not enabled.' },
    { id: 'AwsSolutions-CFR3', reason: 'CloudFront Access Logging intentionally disabled.' },
    { id: 'AwsSolutions-COG2', reason: 'MFA intentionally disabled on self-registration userpool.' },
    { id: 'AwsSolutions-SNS2', reason: 'Server-side encryption intentionally disabled for reduced complexity. This can be enabled by end-users.' },
    { id: 'AwsSolutions-SNS3', reason: 'Intentionally not requiring publishers use SSL/HTTPS.' },
    { id: 'AwsSolutions-SF1', reason: 'Intentionally not logging ALL events to CloudWatch.' },
    { id: 'AwsSolutions-SF2', reason: 'Intentionally not enabling X-RAY Tracing.' },
    { id: 'AwsSolutions-SQS3', reason: 'End-users can add DLQ for enhanced decoupled runtime observability.' },
    { id: 'AwsSolutions-SQS4', reason: 'Intentionally not requiring publishers use SSL/HTTPS.' },
    { id: 'AwsSolutions-EC23', reason: 'Requests made to ports for which there are no listeners will be discarded.' },
    { id: 'AwsSolutions-EC28', reason: 'Jump host does not require autoscaling, detailed monitoring, or termination protection.' },
    { id: 'AwsSolutions-EC29', reason: 'Jump host does not require autoscaling, detailed monitoring, or termination protection.' },

]);
