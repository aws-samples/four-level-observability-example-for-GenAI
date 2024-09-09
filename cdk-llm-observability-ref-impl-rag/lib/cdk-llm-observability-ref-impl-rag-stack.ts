// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { NagSuppressions } from 'cdk-nag';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { aws_opensearchserverless as opensearchserverless } from 'aws-cdk-lib';
import * as customResources from 'aws-cdk-lib/custom-resources';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as ecsPatterns from 'aws-cdk-lib/aws-ecs-patterns';
import * as grafana from 'aws-cdk-lib/aws-grafana';
import { aws_aps as aps } from 'aws-cdk-lib';
import { DockerImageAsset, Platform } from 'aws-cdk-lib/aws-ecr-assets';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import * as tcdk from 'amazon-textract-idp-cdk-constructs';
import * as events from 'aws-cdk-lib/aws-events';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import { ListenerAction, ApplicationProtocol, ListenerCondition, SslPolicy } from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import { HttpOrigin } from 'aws-cdk-lib/aws-cloudfront-origins';
import {
  Distribution, ViewerProtocolPolicy, OriginProtocolPolicy, AllowedMethods, CachePolicy,
  OriginRequestPolicy, OriginRequestCookieBehavior, OriginRequestHeaderBehavior, OriginRequestQueryStringBehavior,
  CacheQueryStringBehavior, CacheHeaderBehavior 
} from 'aws-cdk-lib/aws-cloudfront';
import { CloudFrontTarget, UserPoolDomainTarget } from 'aws-cdk-lib/aws-route53-targets';
import { UserPool, UserPoolClientIdentityProvider, OAuthScope, AdvancedSecurityMode } from 'aws-cdk-lib/aws-cognito';
import { AuthenticateCognitoAction } from 'aws-cdk-lib/aws-elasticloadbalancingv2-actions';
import * as cw from 'aws-cdk-lib/aws-cloudwatch';

export class CdkLlmObservabilityRefImplRagStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    /*
    S3 Buckets

    This is set up to block public access, has server access logs
    enabled, and can send events to Event Bridge

    The second bucket is for CloudFront with a different ownership policy.
    */
    const contentBucket = new s3.Bucket(this, 'DocumentsBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      versioned: false,
      encryption: s3.BucketEncryption.S3_MANAGED,
      serverAccessLogsPrefix: 'accesslogs/',
      enforceSSL: true,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_PREFERRED,
      eventBridgeEnabled: true,
    });
    const cfLogBucket = new s3.Bucket(this, 'CfLogsBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      versioned: false,
      encryption: s3.BucketEncryption.S3_MANAGED,
      serverAccessLogsPrefix: 'accesslogs/',
      enforceSSL: true,
      objectOwnership: s3.ObjectOwnership.OBJECT_WRITER,
    });


    /*
    VPC with 1 NAT Gateway and endpoints for S3, ECR, and KMS
    Also has VPC flow logs enabled
    */
    const vpc = new ec2.Vpc(this, 'VPC', {
      natGateways: 1,
      gatewayEndpoints: {
        S3: {
          service: ec2.GatewayVpcEndpointAwsService.S3,
        },
      },
    });
    vpc.addFlowLog('FlowLogS3', {
      destination: ec2.FlowLogDestination.toS3(contentBucket, 'flowlogs/')
    });
    vpc.addInterfaceEndpoint('EcrDockerEndpoint', {
      service: ec2.InterfaceVpcEndpointAwsService.ECR_DOCKER,
    });
    vpc.addInterfaceEndpoint('KmsEndpoint', {
      service: ec2.InterfaceVpcEndpointAwsService.KMS,
    });

    /*
    Jump host with access to content bucket and OpenSearch cluster
    */
    const jumpHostSG = new ec2.SecurityGroup(this, 'JumpHostSecurityGroup', {
      vpc,
      description: 'Allow all VPC traffic',
      allowAllOutbound: true,
    });
    const jumpHost = new ec2.BastionHostLinux(this, 'JumpHost', {
      vpc,
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MEDIUM),
      machineImage: ec2.MachineImage.latestAmazonLinux2023(),
      securityGroup: jumpHostSG,
      blockDevices: [{
        deviceName: '/dev/sdh',
        volume: ec2.BlockDeviceVolume.ebs(10, {
          encrypted: true,
        }),
    }],
    });
    contentBucket.grantReadWrite(jumpHost);
    jumpHost.instance.role.addManagedPolicy(iam.ManagedPolicy.fromManagedPolicyArn(this, 'ssmpolicy', 'arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore'));
    jumpHost.instance.role.addManagedPolicy(iam.ManagedPolicy.fromManagedPolicyArn(this, 'amppolicy', 'arn:aws:iam::aws:policy/AmazonPrometheusFullAccess'));
    jumpHost.instance.role.addManagedPolicy(iam.ManagedPolicy.fromManagedPolicyArn(this, 'brpolicy', 'arn:aws:iam::aws:policy/AmazonBedrockFullAccess'));
    jumpHost.instance.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          "aoss:ListCollections",
          "aoss:BatchGetCollection",
          "aoss:CreateCollection",
          "aoss:CreateSecurityPolicy",
          "aoss:GetSecurityPolicy",
          "aoss:ListSecurityPolicies",
          "aoss:CreateAccessPolicy",
          "aoss:GetAccessPolicy",
          "aoss:ListAccessPolicies",
          "aoss:APIAccessAll",
          "aoss:DashboardsAccessAll",
          "aoss:ListSecurityPolicies",
          "aoss:ListTagsForResource",
        ],
        resources: ['*']
      })
    );

    /*
    OpenSearch serverless vector database. 

    Has a security group set up for client access. OpenSearch security group
    allows ingress from the client security group and the VPC CIDR range.

    Has a security, network, and data policies set up.

    Uses a Lambda function to initialize the collection.
    */
    const sgUseOpensearch = new ec2.SecurityGroup(this, "OpenSearchClientSG", {
      vpc,
      allowAllOutbound: true,
      description: "security group for an opensearch client",
      securityGroupName: "use-opensearch-cluster-sg",
    });
    const sgOpensearchCluster = new ec2.SecurityGroup(this, "OpenSearchSG", {
      vpc,
      allowAllOutbound: true,
      description: "security group for an opensearch cluster",
      securityGroupName: "opensearch-cluster-sg",
    });
    sgOpensearchCluster.addIngressRule(sgOpensearchCluster, ec2.Port.allTcp(), "opensearch-cluster-sg");
    sgOpensearchCluster.addIngressRule(ec2.Peer.ipv4(vpc.vpcCidrBlock), ec2.Port.allTcp(), "vpc-traffic");
    sgOpensearchCluster.addIngressRule(sgUseOpensearch, ec2.Port.tcp(443), "use-opensearch-cluster-sg");
    sgOpensearchCluster.addIngressRule(sgUseOpensearch, ec2.Port.tcpRange(9200, 9300), "use-opensearch-cluster-sg");
    const vectorSecurityPolicy = new opensearchserverless.CfnSecurityPolicy(this, 'VectorSecurityPolicy', {
      name: 'vectorsecuritypolicy',
      policy: '{"Rules":[{"ResourceType":"collection","Resource":["collection/vectordb"]}],"AWSOwnedKey":true}',
      type: 'encryption',
    });
    const privateSubnetIds = vpc.privateSubnets.map(subnet => subnet.subnetId);
    const vectorVpcEndpoint = new opensearchserverless.CfnVpcEndpoint(this, 'VectorVpcEndpoint', {
      name: 'vectordbvpce',
      subnetIds: privateSubnetIds,
      securityGroupIds: [sgOpensearchCluster.securityGroupId],
      vpcId: vpc.vpcId,
    });
    vectorVpcEndpoint.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);
    const network_security_policy = JSON.stringify([{
      "Rules": [
        {
          "Resource": [
            "collection/vectordb"
          ],
          "ResourceType": "dashboard"
        },
        {
          "Resource": [
            "collection/vectordb"
          ],
          "ResourceType": "collection"
        }
      ],
      "AllowFromPublic": false,
      "SourceVPCEs": [
        vectorVpcEndpoint.attrId
      ]
    }])
    const vectorNetworkPolicy = new opensearchserverless.CfnSecurityPolicy(this, 'VectorNetworkPolicy', {
      name: 'vectornetworkpolicy',
      policy: network_security_policy,
      type: 'network',
    });
    const vectorDB = new opensearchserverless.CfnCollection(this, 'VectorDB', {
      name: 'vectordb',
      description: 'Vector Database',
      standbyReplicas: 'ENABLED',
      type: 'VECTORSEARCH',
    });
    vectorDB.addDependency(vectorSecurityPolicy);
    vectorDB.addDependency(vectorNetworkPolicy);
    const osAdminRole = new iam.Role(this, 'OsAdminRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com')
    });
    osAdminRole.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName("service-role/AWSLambdaVPCAccessExecutionRole"));
    osAdminRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          "aoss:ListCollections",
          "aoss:BatchGetCollection",
          "aoss:CreateCollection",
          "aoss:CreateSecurityPolicy",
          "aoss:GetSecurityPolicy",
          "aoss:ListSecurityPolicies",
          "aoss:CreateAccessPolicy",
          "aoss:GetAccessPolicy",
          "aoss:ListAccessPolicies",
          "aoss:APIAccessAll",
          "aoss:DashboardsAccessAll",
          "aoss:ListSecurityPolicies",
          "aoss:ListTagsForResource",
        ],
        resources: ['*']
      })
    );
    const osInitRole = new iam.Role(this, 'OsInitRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com')
    });
    osInitRole.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName("service-role/AWSLambdaVPCAccessExecutionRole"));
    osInitRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          "aoss:ListCollections",
          "aoss:BatchGetCollection",
          "aoss:CreateCollection",
          "aoss:CreateSecurityPolicy",
          "aoss:GetSecurityPolicy",
          "aoss:ListSecurityPolicies",
          "aoss:CreateAccessPolicy",
          "aoss:GetAccessPolicy",
          "aoss:ListAccessPolicies",
          "aoss:APIAccessAll",
          "aoss:DashboardsAccessAll",
          "aoss:ListSecurityPolicies",
          "aoss:ListTagsForResource",
        ],
        resources: ['*']
      })
    );
    const appRole = new iam.Role(this, 'AppRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com')
    });
    const dataAccessPolicy = JSON.stringify([
      {
        Rules: [
          {
            Resource: [`collection/${vectorDB.name}`],
            Permission: [
              "aoss:*",
            ],
            ResourceType: "collection",
          },
          {
            Resource: [`index/${vectorDB.name}/*`],
            Permission: [
              "aoss:*",
            ],
            ResourceType: "index",
          },
        ],
        Principal: [
          osAdminRole.roleArn,
          osInitRole.roleArn,
          appRole.roleArn,
          jumpHost.instance.role.roleArn
        ],
        Description: "data-access-rule",
      },
    ], null, 2);
    const dataAccessPolicyName = `${vectorDB.name}-policy`;
    const cfnAccessPolicy = new opensearchserverless.CfnAccessPolicy(this, "OpssDataAccessPolicy", {
      name: dataAccessPolicyName,
      description: "Policy for data access",
      policy: dataAccessPolicy,
      type: "data",
    });
    const createOsIndexLambda = new lambda.Function(this, `osIndexCustomResourceLambda`, {
      runtime: lambda.Runtime.PYTHON_3_12,
      vpc: vpc,
      code: lambda.Code.fromAsset("lambda/ossetup", {
        bundling: {
          image: lambda.Runtime.PYTHON_3_12.bundlingImage,
          command: [
            'bash', '-c',
            'pip install -r requirements.txt -t /asset-output && cp -au . /asset-output'
          ],
        },
      }),
      handler: 'lambda_function.on_event',
      tracing: lambda.Tracing.ACTIVE,
      timeout: cdk.Duration.minutes(1),
      memorySize: 1024,
      role: osAdminRole,
      environment: {
        DOMAINURL: vectorDB.attrCollectionEndpoint,
        INDEX: 'embeddings',
        REGION: this.region
      }
    }
    );
    const customResourceProvider = new customResources.Provider(this, `osIndexCustomResourceProvider`, {
      onEventHandler: createOsIndexLambda,
      vpc: vpc,
      role: osInitRole,
    }
    );
    const osSetupResource = new cdk.CustomResource(this, `customResourceConfigureIndex`, {
      serviceToken: customResourceProvider.serviceToken,
    });

    /*
    ECS cluster for Fargate tasks

    We'll run the OpenTelemetry Collector here, as well as our front-end application
    */
    const cluster = new ecs.Cluster(this, 'Cluster', {
      vpc,
      enableFargateCapacityProviders: true,
      containerInsights: true
    });

    /*
     AMP / Grafana
     */
    const prometheus = new aps.CfnWorkspace(this, 'PrometheusWorkspace', /* all optional props */ {
      alias: 'genai-prometheus',
    });
    const grafanaSG = new ec2.SecurityGroup(this, 'GrafanaSecurityGroup', {
      vpc,
      description: 'Allow all VPC traffic',
      allowAllOutbound: true,
    });
    const grafanaRole = new iam.Role(this, 'grafanaRole', {
      assumedBy: new iam.ServicePrincipal('grafana.amazonaws.com')
    });
    grafanaRole.addManagedPolicy(iam.ManagedPolicy.fromManagedPolicyArn(this, 'amppolicygr', 'arn:aws:iam::aws:policy/AmazonPrometheusFullAccess'));
    grafanaRole.addManagedPolicy(iam.ManagedPolicy.fromManagedPolicyArn(this, 'cwpolicygr', 'arn:aws:iam::aws:policy/service-role/AmazonGrafanaCloudWatchAccess'));
    const grafanaWs = new grafana.CfnWorkspace(this, 'GrafanaWorkspace', {
      accountAccessType: 'CURRENT_ACCOUNT',
      authenticationProviders: ['AWS_SSO'],
      permissionType: 'CUSTOMER_MANAGED',
    
      // the properties below are optional
      grafanaVersion: '9.4',
      pluginAdminEnabled: true,
      roleArn: grafanaRole.roleArn,
      vpcConfiguration: {
        securityGroupIds: [grafanaSG.securityGroupId],
        subnetIds: privateSubnetIds
      },
    });
    const adotRole = new iam.Role(this, "adottaskrole", {
      assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com")
    });
    adotRole.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName("AWSXRayDaemonWriteAccess")
    );
    adotRole.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName("AmazonPrometheusRemoteWriteAccess")
    );
    adotRole.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName("CloudWatchLogsFullAccess")
    );
    adotRole.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName('CloudWatchReadOnlyAccess'));
    const promExportImage = new DockerImageAsset(this, 'PromExportImage', {
      directory: 'container/promexport',
      platform: Platform.LINUX_AMD64
    });
    const adotTaskDefinition = new ecs.FargateTaskDefinition(this, "ADOT", {
      taskRole: adotRole,
      cpu: 1024,
      memoryLimitMiB:2048 
    });
    const adotConfig = new ssm.StringParameter(this, "adotconfig", {
      parameterName: 'otel-collector-config',
      stringValue: `
      receivers:
        otlp: 
          protocols:
            grpc:
              endpoint: 0.0.0.0:4317
            http:
              endpoint: 0.0.0.0:4318
        prometheus:
          config:
            global:
              scrape_interval: 15s
              scrape_timeout: 10s
            scrape_configs:
            - job_name: "cw-export-app"
              static_configs:
              - targets: [ 0.0.0.0:9106]

      
      processors:
        batch:
          
      exporters:
        prometheusremotewrite:
          endpoint: ${prometheus.attrPrometheusEndpoint}api/v1/remote_write
          auth:
            authenticator: sigv4auth
        awsxray: 
          region: ${this.region}
        logging:
          loglevel: debug
          
      extensions:
        sigv4auth:
          region: ${this.region}
          
      service:
        extensions: [sigv4auth]  
        pipelines:
          traces:    
            receivers: [otlp]
            processors: [batch]    
            exporters: [awsxray]
              
          metrics:    
            receivers: [otlp,prometheus]
            processors: [batch]
            exporters: [prometheusremotewrite]
    `
    })
    const adotContainer = adotTaskDefinition.addContainer("AdotContainer", {
      image: ecs.ContainerImage.fromRegistry("public.ecr.aws/aws-observability/aws-otel-collector:latest"),
      secrets: {
        AOT_CONFIG_CONTENT: ecs.Secret.fromSsmParameter(adotConfig)
      },
      cpu: 512,
      memoryLimitMiB: 1024,
      logging: ecs.LogDriver.awsLogs({ streamPrefix: "adot" })
    });
    const promExportContainer = adotTaskDefinition.addContainer('PromExportContainer', {
      image: ecs.ContainerImage.fromDockerImageAsset(promExportImage),
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'prom-export-log-group', logRetention: 30 }),
      cpu: 512,
      memoryLimitMiB: 1024,
    });
    promExportContainer.addPortMappings({ containerPort: 9106, protocol: ecs.Protocol.TCP });
    adotContainer.addPortMappings({
      containerPort: 4318,
      hostPort: 4318,
      protocol: ecs.Protocol.TCP,
      appProtocol: ecs.AppProtocol.http2,
      name: "adot-4318-tcp"
    });
    const adotService = new ecsPatterns.NetworkLoadBalancedFargateService(this, "ADOTService", {
      serviceName: "adsotsvc",
      cluster,
      taskDefinition: adotTaskDefinition,
      publicLoadBalancer: false
    });
    adotService.service.connections.securityGroups[0].addIngressRule(
      ec2.Peer.ipv4(vpc.vpcCidrBlock),
      ec2.Port.allTcp(),
      "Allow inbound from VPC for ADOT"
    );
    adotService.service.autoScaleTaskCount({ maxCapacity: 2 })
      .scaleOnCpuUtilization("AUTOSCALING", {
        targetUtilizationPercent: 70,
        scaleInCooldown: cdk.Duration.seconds(60),
        scaleOutCooldown: cdk.Duration.seconds(60)
      });

    /*
    MLFlow for tracking user feedback
    */
    const mlflowRole = new iam.Role(this, 'MLFlowRole', {
      assumedBy: new iam.ServicePrincipal('sagemaker.amazonaws.com')
    });
    mlflowRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          "s3:Get*",
          "s3:Put*",
          "sagemaker:AddTags",
          "sagemaker:CreateModelPackageGroup",
          "sagemaker:CreateModelPackage",
          "sagemaker:DescribeModelPackageGroup",
          "sagemaker:UpdateModelPackage",
          "s3:List*"
        ],
        resources: ['*']
      })
    );
    const mlFlowServer = new cdk.CfnResource(this, 'MLFlow server', {
      type: 'AWS::SageMaker::MlflowTrackingServer',
      properties: { 
        ArtifactStoreUri: `s3://${contentBucket.bucketName}/feedback}`,
        TrackingServerName: 'LLMObservability',
        TrackingServerSize: 'Small',
        RoleArn: mlflowRole.roleArn
      },
    });

    // Application
    const appImage = new DockerImageAsset(this, 'AppImage', {
      directory: 'container/app',
      platform: Platform.LINUX_AMD64
    });
    const appTaskDefinition = new ecs.FargateTaskDefinition(this, 'AppTaskDef', {
      cpu: 512,
      memoryLimitMiB: 2048,
      taskRole: appRole
    });
    const appContainer = appTaskDefinition.addContainer('StreamlitContainer', {
      image: ecs.ContainerImage.fromDockerImageAsset(appImage),
      cpu: 512,
      memoryLimitMiB: 2048,
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'streamlit-log-group', logRetention: 30 }),
      environment: {
        'OPENSEARCH_ENDPOINT': vectorDB.attrCollectionEndpoint,
        'OPENSEARCH_INDEX': 'embeddings',
        'MLFLOW_TRACKING_ARN': mlFlowServer.getAtt("TrackingServerArn").toString(),
        'TRACELOOP_BASE_URL': `http://${adotService.loadBalancer.loadBalancerDnsName}:80`
      }
    });
    appRole.addManagedPolicy(iam.ManagedPolicy.fromManagedPolicyArn(this, 'brpolicyapp', 'arn:aws:iam::aws:policy/AmazonBedrockFullAccess'));
    appRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
          "aoss:ListCollections",
          "aoss:BatchGetCollection",
          "aoss:CreateCollection",
          "aoss:CreateSecurityPolicy",
          "aoss:GetSecurityPolicy",
          "aoss:ListSecurityPolicies",
          "aoss:CreateAccessPolicy",
          "aoss:GetAccessPolicy",
          "aoss:ListAccessPolicies",
          "aoss:APIAccessAll",
          "aoss:DashboardsAccessAll",
          "aoss:ListSecurityPolicies",
          "aoss:ListTagsForResource",
          "sagemaker-mlflow:*"
      ],
      resources: ['*']
    }))
    appRole.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName("AmazonS3FullAccess")
    );
    appRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'cloudwatch:PutMetricData',
        ],
        resources: ['*']
      })
    );
    appContainer.addPortMappings({ containerPort: 8501, protocol: ecs.Protocol.TCP });

    // Ragas
    const ragasImage = new DockerImageAsset(this, 'RagasImage', {
      directory: 'container/ragas',
      platform: Platform.LINUX_AMD64
    });
    const ragasRole = new iam.Role(this, 'RagasRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com')
    });
    ragasRole.addManagedPolicy(iam.ManagedPolicy.fromManagedPolicyArn(this, 'brpolicyragas', 'arn:aws:iam::aws:policy/AmazonBedrockFullAccess'));
    ragasRole.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName("AmazonS3FullAccess")
    );
    ragasRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'cloudwatch:PutMetricData',
        ],
        resources: ['*']
      })
    );
    const ragasTaskDefinition = new ecs.FargateTaskDefinition(this, 'RagasTaskDef', {
      cpu: 4096,
      memoryLimitMiB: 16384,
      taskRole: ragasRole
    });
    const ragasContainer = ragasTaskDefinition.addContainer('RagasContainer', {
      image: ecs.ContainerImage.fromDockerImageAsset(ragasImage),
      cpu: 4096,
      memoryLimitMiB: 16384,
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'ragas-log-group', logRetention: 30 }),
      environment: {
        'BUCKET': `${contentBucket.bucketName}`,
        'DOC_PATH': `ingest/`
      }
    });
    const ragasRule = new events.Rule(this, 'RagasScheduleRule', {
      schedule: events.Schedule.cron({ minute: '0', hour: '0' }), // Run daily at midnight UTC
    });
    ragasRule.addTarget(new targets.EcsTask({
      cluster,
      taskDefinition: ragasTaskDefinition,
      launchType: ecs.LaunchType.FARGATE,
      taskCount: 1,
    }));

    /*
    Step Functions workflow. Fired by S3 event in content bucket.

    Uses Textract and Lambda to extract paragraphs, then creates an 
    embedding for each paragraph.
    */
    const decider_task = new tcdk.TextractPOCDecider(this, "Decider", {});
    const textract_async_task = new tcdk.TextractGenericAsyncSfnTask(this, "TextractAsync", {
      s3OutputBucket: contentBucket.bucketName,
      s3TempOutputPrefix: 'textract/out',
      integrationPattern: sfn.IntegrationPattern.WAIT_FOR_TASK_TOKEN,
      taskTimeout: sfn.Timeout.duration(cdk.Duration.hours(1)),
      input: sfn.TaskInput.fromObject({
        Token: sfn.JsonPath.taskToken,
        ExecutionId: sfn.JsonPath.stringAt('$$.Execution.Id'),
        Payload: sfn.JsonPath.entirePayload
      }),
      resultPath: '$.textract_result'
    });
    const lambda_textract_post_processing_function = new lambda.DockerImageFunction(this, 'LambdaTextractPostProcessing', {
      code: lambda.DockerImageCode.fromImageAsset('lambda/textractpostprocessor'),
      tracing: lambda.Tracing.ACTIVE,
      timeout: cdk.Duration.minutes(15),
      memorySize: 2048,
      environment: {
        SKIP_PAGES: "CONTENTS,TABLE OF CONTENTS,FOREWORDS, ANNEXES,Table of Contents,ACRONYMS, ABBREVIATIONS",
        NO_LINES_HEADER: "3",
        NO_LINES_FOOTER: "10",
        FILTER_PARA_WORDS: "10"
      }
    });
    contentBucket.grantReadWrite(lambda_textract_post_processing_function);
    const textractAsyncCallTask = new tasks.LambdaInvoke(this, "TextractPostProcessorTask", {
      lambdaFunction: lambda_textract_post_processing_function,
      resultPath: "$",
      outputPath: "$.Payload"
    });
    const csvToEmbeddingFn = new lambda.Function(this, 'csvToEmbeddingFn', {
      runtime: lambda.Runtime.PYTHON_3_12,
      vpc: vpc,
      code: lambda.Code.fromAsset('lambda/embeddingprocessor', {
        bundling: {
          image: lambda.Runtime.PYTHON_3_12.bundlingImage,
          command: [
            'bash', '-c',
            'pip install -r requirements.txt -t /asset-output && cp -au . /asset-output'
          ],
        },
      }),
      handler: 'lambda_function.lambda_handler',
      tracing: lambda.Tracing.ACTIVE,
      timeout: cdk.Duration.minutes(1),
      memorySize: 1024,
      role: osAdminRole,
      environment: {
        DOMAINURL: vectorDB.attrCollectionEndpoint,
        INDEX: 'embeddings',
        REGION: this.region
      }
    });
    osAdminRole.addManagedPolicy(iam.ManagedPolicy.fromManagedPolicyArn(this, 'brpolicyos', 'arn:aws:iam::aws:policy/AmazonBedrockFullAccess'));
    const csvToEmbedding = new sfn.CustomState(this, "CsvToEmbeddingMap", {
      stateJson: {
        Type: "Map",
        ItemProcessor: {
          ProcessorConfig: {
            Mode: "DISTRIBUTED",
            ExecutionType: "EXPRESS"
          },
          StartAt: "LambdaBatchProcessor",
          States: {
            LambdaBatchProcessor: {
              Type: "Task",
              Resource: "arn:aws:states:::lambda:invoke",
              OutputPath: "$.Payload",
              Parameters: {
                "Payload.$": "$",
                "FunctionName": csvToEmbeddingFn.functionArn
              },
              Retry: [
                {
                  ErrorEquals: [
                    "Lambda.ServiceException",
                    "Lambda.AWSLambdaException",
                    "Lambda.SdkClientException",
                    "Lambda.TooManyRequestsException"
                  ],
                  IntervalSeconds: 2,
                  MaxAttempts: 6,
                  BackoffRate: 2
                }
              ],
              End: true
            }
          }
        },
        ItemReader: {
          Resource: "arn:aws:states:::s3:getObject",
          ReaderConfig: {
            InputType: "CSV",
            CSVHeaderLocation: "FIRST_ROW"
          },
          Parameters: {
            "Bucket.$": "$.csvBucket",
            "Key.$": "$.csvPath"
          }
        },
        MaxConcurrency: 5,
        Label: "CsvToEmbedding",
        ItemBatcher: {
          MaxItemsPerBatch: 5,
          MaxInputBytesPerBatch: 2048
        }
      }
    })
    const async_chain = sfn.Chain.start(textract_async_task).next(textractAsyncCallTask).next(csvToEmbedding);
    const workflow_chain = sfn.Chain.start(decider_task).next(async_chain);
    const sfnPdfToText = new sfn.StateMachine(this, 'StateMachinePdfToText', {
      definition: workflow_chain,
      timeout: cdk.Duration.minutes(30),
    });
    csvToEmbeddingFn.grantInvoke(sfnPdfToText);
    contentBucket.grantReadWrite(sfnPdfToText);
    sfnPdfToText.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'states:Start*',
          'states:Send*',
          'states:List*',
          'states:Get*',
          'states:Describe*',
        ],
        resources: ['arn:aws:states:' + this.region + ':' + this.account + ':stateMachine:StateMachinePdfToText*']
      })
    );

    /*
    Event Bridge rule to trigger Step Functions when object put into S3
    */
    const rulePdfToText = new events.Rule(this, 'rulePdfToText', {
      eventPattern: {
        source: ["aws.s3"],
        detailType: ["Object Created"],
        detail: {
          bucket: {
            name: [contentBucket.bucketName]
          },
          object: {
            key: [{
              prefix: "ingest"
            }]
          }
        }
      },
    });
    const dlq_sfn = new sqs.Queue(this, 'DeadLetterQueueSFN');
    const role_events = new iam.Role(this, 'RoleEventBridge', {
      assumedBy: new iam.ServicePrincipal('events.amazonaws.com'),
    });
    rulePdfToText.addTarget(new targets.SfnStateMachine(sfnPdfToText, {
      input: events.RuleTargetInput.fromObject({ s3Path: `s3://${events.EventField.fromPath('$.detail.bucket.name')}/${events.EventField.fromPath('$.detail.object.key')}` }),
      deadLetterQueue: dlq_sfn,
      role: role_events
    }));

    // Route 53
    const appCustomDomainName = this.node.tryGetContext('appCustomDomainName');
    const loadBalancerOriginCustomDomainName = this.node.tryGetContext('loadBalancerOriginCustomDomainName');
    const customDomainRoute53HostedZoneID = this.node.tryGetContext('customDomainRoute53HostedZoneID');
    const customDomainRoute53HostedZoneName = this.node.tryGetContext('customDomainRoute53HostedZoneName');
    const hosted_zone = route53.HostedZone.fromHostedZoneAttributes(this, 'HostedZone', {
      hostedZoneId: customDomainRoute53HostedZoneID,
      zoneName: customDomainRoute53HostedZoneName
    });
    const certificateApp = new acm.Certificate(this, "ACMCertificateApp", {
      domainName: appCustomDomainName,
      validation: acm.CertificateValidation.fromDns(hosted_zone)
    });
    const certificateAlb = new acm.Certificate(this, "ACMCertificateAlb", {
      domainName: loadBalancerOriginCustomDomainName,
      validation: acm.CertificateValidation.fromDns(hosted_zone)
    });

    // Front-end service and distribution 
    const feService = new ecsPatterns.ApplicationLoadBalancedFargateService(this, 'FeService', {
      cluster: cluster,
      taskDefinition: appTaskDefinition,
      protocol: ApplicationProtocol.HTTPS,
      certificate: certificateAlb,
      domainName: loadBalancerOriginCustomDomainName,
      domainZone: hosted_zone,
      sslPolicy: SslPolicy.RECOMMENDED_TLS
    });
    feService.loadBalancer.logAccessLogs(contentBucket, 'alblog')
    const alb_sg = feService.loadBalancer.connections.securityGroups[0];
    alb_sg.addEgressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), 'Allow HTTPS');
    const customHeaderValue = '9p008atgcg'
    const origin = new HttpOrigin(`${loadBalancerOriginCustomDomainName}`, {
      protocolPolicy: OriginProtocolPolicy.HTTPS_ONLY,
      customHeaders: {
        "X-Custom-Header": customHeaderValue
      }
    });
    // Origin request policy
    const originRequestPolicy = new OriginRequestPolicy(this, 'OriginRequestPolicy', {
      originRequestPolicyName: 'ALBPolicy',
      cookieBehavior: OriginRequestCookieBehavior.all(),
      headerBehavior: OriginRequestHeaderBehavior.all(),
      queryStringBehavior: OriginRequestQueryStringBehavior.all(),
    });
    const distribution = new Distribution(this, 'Distribution', {
      certificate: certificateApp,
      domainNames: [appCustomDomainName],
      enableLogging: true,
      logBucket: cfLogBucket,
      logFilePrefix: 'cflog',
      defaultBehavior: {
        origin: origin,
        viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        originRequestPolicy: originRequestPolicy,
        allowedMethods: AllowedMethods.ALLOW_ALL,
        cachePolicy: CachePolicy.CACHING_DISABLED,
      }
    });
    const cloudFrontDNS = new route53.ARecord(this, 'CloudFrontARecord', {
      zone: hosted_zone,
      target: route53.RecordTarget.fromAlias(new CloudFrontTarget(distribution)),
      recordName: appCustomDomainName
    });

    // Cognito
    const userPool = new UserPool(this, 'UserPool', {
      selfSignUpEnabled: false,
      signInAliases: { email: true },
      passwordPolicy: {
          minLength: 8,
          requireLowercase: true,
          requireUppercase: true,
          requireDigits: true,
          requireSymbols: true
      },
      advancedSecurityMode: AdvancedSecurityMode.ENFORCED
    });
    const userPoolClient = userPool.addClient('UserPoolClient', {
      userPoolClientName: "alb-auth-client",
      generateSecret: true,
      oAuth: {
        flows: {
          authorizationCodeGrant: true,
        },
        scopes: [OAuthScope.OPENID],
        callbackUrls: [`https://${distribution.distributionDomainName}/oauth2/idpresponse`,
        `https://${distribution.distributionDomainName}`,
        `https://${appCustomDomainName}/oauth2/idpresponse`,
        `https://${appCustomDomainName}`,
        ],
        logoutUrls: [`https://${distribution.distributionDomainName}`,
        `https://${appCustomDomainName}`,
        ]
      },
      supportedIdentityProviders: [
        UserPoolClientIdentityProvider.COGNITO
      ]
    });
    const domain_prefix = appCustomDomainName.replace(/\./g, '-')
    let result;
    if (domain_prefix.length > 20) {
      result = domain_prefix.slice(0, 20);
    } else {
      result = domain_prefix;
    }
    if (result.endsWith('-')) {
      result = result.slice(0, -1);
    }
    const userPoolDomain = userPool.addDomain('UserPoolDomain', {
      cognitoDomain: {
        domainPrefix: result
      }
    });
    feService.listener.addAction(
      'cognito-auth', {
      priority: 1,
      conditions: [ListenerCondition.httpHeader("X-Custom-Header", [customHeaderValue])],
      action: new AuthenticateCognitoAction({
        userPool,
        userPoolClient,
        userPoolDomain,
        next: ListenerAction.forward([feService.targetGroup])
      })
    }
    );
    feService.listener.addAction(
      'Default', {
      action: ListenerAction.fixedResponse(403, {
        contentType: 'text/plain',
        messageBody: 'Forbidden'
      })
    }
    );

    /* 
    Cloudwatch dashboard

    This is for Layer 1 metrics - component level information

    We also use a custom resource to get the AOSS index ID

    Dashboards are laid our in a grid. Each row is width 24. Each widget
    normally is width 6, so 4 per row.

    Each call to `addWidget` starts a new row.
    */
    const getOsIndexLambda = new lambda.Function(this, `osGetIndexCustomResourceLambda`, {
      runtime: lambda.Runtime.PYTHON_3_12,
      vpc: vpc,
      code: lambda.Code.fromAsset("lambda/osindexid", {
        bundling: {
          image: lambda.Runtime.PYTHON_3_12.bundlingImage,
          command: [
            'bash', '-c',
            'pip install -r requirements.txt -t /asset-output && cp -au . /asset-output'
          ],
        },
      }),
      handler: 'lambda_function.on_event',
      tracing: lambda.Tracing.ACTIVE,
      timeout: cdk.Duration.minutes(1),
      memorySize: 1024,
      role: osAdminRole,
      environment: {
        DOMAINURL: vectorDB.attrCollectionEndpoint,
        INDEX: 'embeddings',
        REGION: this.region
      }
    }
    );
    const osIndexCustomResourceProvider = new customResources.Provider(this, `osGetIndexCustomResourceProvider`, {
      onEventHandler: getOsIndexLambda,
      vpc: vpc,
      role: osInitRole,
    }
    );
    const osGetIndexCR = new cdk.CustomResource(this, `customResourceGetIndex`, {
      serviceToken: osIndexCustomResourceProvider.serviceToken,
    });
    osGetIndexCR.node.addDependency(osSetupResource);
    const aossIndexId = osGetIndexCR.getAttString('IndexId');
    const dashboardBedrock = new cw.Dashboard(this, 'L1DashboardBedrock', {
      defaultInterval: cdk.Duration.days(7),
      dashboardName: "RAG_Layer_1-Component_Level-Models"
    });
    dashboardBedrock.addWidgets(new cw.TextWidget({
      markdown: '# Bedrock (All Models)',
      width: 24
    }));
    dashboardBedrock.addWidgets(
      new cw.GraphWidget({
        title: "Model Invocations (All Models)",
        view: cw.GraphWidgetView.TIME_SERIES,
        width: 12,
        left: [new cw.Metric({
          metricName: "Invocations",
          namespace: 'AWS/Bedrock',
          statistic: cw.Stats.SAMPLE_COUNT
        })],
      }),
      new cw.GraphWidget({
        title: "Model Invocation Errors (All Models)",
        view: cw.GraphWidgetView.TIME_SERIES,
        width: 12,
        left: [new cw.Metric({
          metricName: "InvocationClientErrors",
          namespace: 'AWS/Bedrock',
          statistic: cw.Stats.SAMPLE_COUNT
        })],
      })
    );
    dashboardBedrock.addWidgets(new cw.TextWidget({
      markdown: '# Bedrock (Text Models)',
      width: 24
    }));
    dashboardBedrock.addWidgets(
      new cw.GraphWidget({
        title: "Model Invocations (Claude 3 Haiku)",
        view: cw.GraphWidgetView.TIME_SERIES,
        width: 12,
        left: [new cw.Metric({
          metricName: "Invocations",
          namespace: 'AWS/Bedrock',
          statistic: cw.Stats.SAMPLE_COUNT,
          dimensionsMap: {
            ModelId: "anthropic.claude-3-haiku-20240307-v1:0"
          }
        })], 
      }),
      new cw.GraphWidget({
        title: "Invocation Latency (Claude 3 Haiku)",
        view: cw.GraphWidgetView.TIME_SERIES,
        width: 12,
        left: [new cw.Metric({
          metricName: "InvocationLatency",
          namespace: 'AWS/Bedrock',
          statistic: cw.Stats.AVERAGE,
          dimensionsMap: {
            ModelId: "anthropic.claude-3-haiku-20240307-v1:0"
          }
        })],
      })
    );
    dashboardBedrock.addWidgets(
      new cw.GraphWidget({
      title: "Input Tokens (Claude 3 Haiku)",
      view: cw.GraphWidgetView.TIME_SERIES,
      width: 12,
      left: [new cw.Metric({
        metricName: "InputTokenCount",
        namespace: 'AWS/Bedrock',
        statistic: cw.Stats.SAMPLE_COUNT,
        dimensionsMap: {
          ModelId: "anthropic.claude-3-haiku-20240307-v1:0"
        }
        })],
      }),
      new cw.GraphWidget({
        title: "Output Tokens (Claude 3 Haiku)",
        view: cw.GraphWidgetView.TIME_SERIES,
        width: 12,
        left: [new cw.Metric({
          metricName: "OutputTokenCount",
          namespace: 'AWS/Bedrock',
          statistic: cw.Stats.SAMPLE_COUNT,
          dimensionsMap: {
            ModelId: "anthropic.claude-3-haiku-20240307-v1:0"
          }
        })],
      })
    );
    dashboardBedrock.addWidgets(new cw.GraphWidget({
      title: "Model Invocation Errors (Claude 3 Haiku)",
      view: cw.GraphWidgetView.TIME_SERIES,
      width: 12,
      left: [new cw.Metric({
        metricName: "InvocationClientErrors",
        namespace: 'AWS/Bedrock',
        statistic: cw.Stats.SAMPLE_COUNT,
        dimensionsMap: {
          ModelId: "anthropic.claude-3-haiku-20240307-v1:0"
        }
      })],
    }));
    dashboardBedrock.addWidgets(new cw.TextWidget({
      markdown: '# Bedrock (Embedding Models)',
      width: 24
    }));
    dashboardBedrock.addWidgets(
      new cw.GraphWidget({
        title: "Invocation Latency (Titan Embeddings)",
        view: cw.GraphWidgetView.TIME_SERIES,
        width: 12,
        left: [new cw.Metric({
          metricName: "InvocationLatency",
          namespace: 'AWS/Bedrock',
          statistic: cw.Stats.AVERAGE,
          dimensionsMap: {
            ModelId: "amazon.titan-embed-text-v2:0"
          }
        })],
      }),
      new cw.GraphWidget({
        title: "Input Tokens (Titan Embeddings)",
        view: cw.GraphWidgetView.TIME_SERIES,
        width: 12,
        left: [new cw.Metric({
          metricName: "InputTokenCount",
          namespace: 'AWS/Bedrock',
          statistic: cw.Stats.SAMPLE_COUNT,
          dimensionsMap: {
            ModelId: "amazon.titan-embed-text-v2:0"
          }
        })],
      })
    );
    dashboardBedrock.addWidgets(new cw.GraphWidget({
      title: "Input Tokens (Titan Embeddings)",
      view: cw.GraphWidgetView.TIME_SERIES,
      width: 12,
      left: [new cw.Metric({
        metricName: "InputTokenCount",
        namespace: 'AWS/Bedrock',
        statistic: cw.Stats.SAMPLE_COUNT,
        dimensionsMap: {
          ModelId: "amazon.titan-embed-text-v2:0"
        }
      })],
    }));
    const dashboardOS = new cw.Dashboard(this, 'L1DashboardOS', {
      defaultInterval: cdk.Duration.days(7),
      dashboardName: "RAG_Layer_1-Component_Level-Vector_DB"
    });
    dashboardOS.addWidgets(new cw.TextWidget({
      markdown: '# OpenSearch Vector Database (account level)',
      width: 24
    }));
    dashboardOS.addWidgets(
      new cw.GraphWidget({
        title: "Indexing capacity units",
        view: cw.GraphWidgetView.TIME_SERIES,
        width: 12,
        left: [new cw.Metric({
          metricName: "IndexingOCU",
          namespace: 'AWS/AOSS',
          statistic: cw.Stats.SUM,
          dimensionsMap: {
            ClientId: this.account,
          }
        })],
      }),
      new cw.GraphWidget({
        title: "Search capacity units",
        view: cw.GraphWidgetView.TIME_SERIES,
        width: 12,
        left: [new cw.Metric({
          metricName: "SearchOCU",
          namespace: 'AWS/AOSS',
          statistic: cw.Stats.SUM,
          dimensionsMap: {
            ClientId: this.account,
          }
        })],
      })
    );
    dashboardOS.addWidgets(new cw.TextWidget({
      markdown: '# OpenSearch Vector Database (collection level)',
      width: 24
    }));
    dashboardOS.node.addDependency(vectorDB);
    dashboardOS.addWidgets(
      new cw.GraphWidget({
        title: "OpenSearch response codes",
        view: cw.GraphWidgetView.TIME_SERIES,
        width: 12,
        left: [
          new cw.Metric({
            metricName: "2xx",
            namespace: 'AWS/AOSS',
            statistic: cw.Stats.SUM,
            dimensionsMap: {
              ClientId: this.account,
              CollectionId: vectorDB.attrId,
              CollectionName: vectorDB.name 
            }
          }),
          new cw.Metric({
            metricName: "3xx",
            namespace: 'AWS/AOSS',
            statistic: cw.Stats.SUM,
            dimensionsMap: {
              ClientId: this.account,
              CollectionId: vectorDB.attrId,
              CollectionName: vectorDB.name 
            }
          }),
          new cw.Metric({
            metricName: "4xx",
            namespace: 'AWS/AOSS',
            statistic: cw.Stats.SUM,
            dimensionsMap: {
              ClientId: this.account,
              CollectionId: vectorDB.attrId,
              CollectionName: vectorDB.name 
            }
          }),
          new cw.Metric({
            metricName: "5xx",
            namespace: 'AWS/AOSS',
            statistic: cw.Stats.SUM,
            dimensionsMap: {
              ClientId: this.account,
              CollectionId: vectorDB.attrId,
              CollectionName: vectorDB.name 
            }
          })
        ],
      }),
      new cw.GraphWidget({
        title: "Search Request Rate",
        view: cw.GraphWidgetView.TIME_SERIES,
        width: 12,
        left: [new cw.Metric({
          metricName: "SearchRequestRate",
          namespace: 'AWS/AOSS',
          statistic: cw.Stats.AVERAGE,
          dimensionsMap: {
            ClientId: this.account,
            CollectionId: vectorDB.attrId,
            CollectionName: vectorDB.name 
          }
        })],
      })
    );
    dashboardOS.addWidgets(
      new cw.GraphWidget({
        title: "Search Request Latency",
        view: cw.GraphWidgetView.TIME_SERIES,
        width: 12,
        left: [new cw.Metric({
          metricName: "SearchRequestLatency",
          namespace: 'AWS/AOSS',
          statistic: cw.Stats.AVERAGE,
          dimensionsMap: {
            ClientId: this.account,
            CollectionId: vectorDB.attrId,
            CollectionName: vectorDB.name 
          }
        })],
      }),
      new cw.GraphWidget({
        title: "Search Request Errors",
        view: cw.GraphWidgetView.TIME_SERIES,
        width: 12,
        left: [new cw.Metric({
          metricName: "SearchRequestErrors",
          namespace: 'AWS/AOSS',
          statistic: cw.Stats.SUM,
          dimensionsMap: {
            ClientId: this.account,
            CollectionId: vectorDB.attrId,
            CollectionName: vectorDB.name 
          }
        })],
      })
    );
    dashboardOS.addWidgets(
      new cw.GraphWidget({
        title: "Ingestion Request Successes",
        view: cw.GraphWidgetView.TIME_SERIES,
        width: 12,
        left: [new cw.Metric({
          metricName: "IngestionRequestSuccess",
          namespace: 'AWS/AOSS',
          statistic: cw.Stats.SUM,
          dimensionsMap: {
            ClientId: this.account,
            CollectionId: vectorDB.attrId,
            CollectionName: vectorDB.name 
          }
        })],
      }),
      new cw.GraphWidget({
        title: "Ingestion Request Rate",
        view: cw.GraphWidgetView.TIME_SERIES,
        width: 12,
        left: [new cw.Metric({
          metricName: "IngestionRequestRate",
          namespace: 'AWS/AOSS',
          statistic: cw.Stats.AVERAGE,
          dimensionsMap: {
            ClientId: this.account,
            CollectionId: vectorDB.attrId,
            CollectionName: vectorDB.name 
          }
        })],
      })
    );
    dashboardOS.addWidgets(
      new cw.GraphWidget({
        title: "Ingestion Request Latency",
        view: cw.GraphWidgetView.TIME_SERIES,
        width: 12,
        left: [new cw.Metric({
          metricName: "IngestionRequestLatency",
          namespace: 'AWS/AOSS',
          statistic: cw.Stats.AVERAGE,
          dimensionsMap: {
            ClientId: this.account,
            CollectionId: vectorDB.attrId,
            CollectionName: vectorDB.name 
          }
        })],
      }),
      new cw.GraphWidget({
        title: "Ingestion Request Errors",
        view: cw.GraphWidgetView.TIME_SERIES,
        width: 12,
        left: [new cw.Metric({
          metricName: "IngestionRequestErrors",
          namespace: 'AWS/AOSS',
          statistic: cw.Stats.SUM,
          dimensionsMap: {
            ClientId: this.account,
            CollectionId: vectorDB.attrId,
            CollectionName: vectorDB.name 
          }
        })],
      })
    );
    dashboardOS.addWidgets(new cw.TextWidget({
      markdown: '# OpenSearch Vector Database (index level)',
      width: 24
    }));
    dashboardOS.addWidgets(
      new cw.GraphWidget({
        title: "Deleted documents",
        view: cw.GraphWidgetView.TIME_SERIES,
        width: 12,
        left: [new cw.Metric({
          metricName: "DeletedDocuments",
          namespace: 'AWS/AOSS',
          statistic: cw.Stats.SUM,
          dimensionsMap: {
            ClientId: this.account,
            CollectionId: vectorDB.attrId,
            CollectionName: vectorDB.name,
            IndexId: aossIndexId,
            IndexName: "embeddings"
          }
        })],
      }),
      new cw.GraphWidget({
        title: "Searchable documents",
        view: cw.GraphWidgetView.TIME_SERIES,
        width: 12,
        left: [new cw.Metric({
          metricName: "SearchableDocuments",
          namespace: 'AWS/AOSS',
          statistic: cw.Stats.SUM,
          dimensionsMap: {
            ClientId: this.account,
            CollectionId: vectorDB.attrId,
            CollectionName: vectorDB.name,
            IndexId: aossIndexId,
            IndexName: "embeddings"
          }
        })],
      })
    );
    dashboardOS.addWidgets(
      new cw.GraphWidget({
        title: "S3 storage consumption",
        view: cw.GraphWidgetView.TIME_SERIES,
        width: 12,
        left: [new cw.Metric({
          metricName: "StorageUsedInS3",
          namespace: 'AWS/AOSS',
          statistic: cw.Stats.SUM,
          dimensionsMap: {
            ClientId: this.account,
            CollectionId: vectorDB.attrId,
            CollectionName: vectorDB.name,
            IndexId: aossIndexId,
            IndexName: "embeddings"
          }
        })],
      }),
      new cw.GraphWidget({
        title: "Document ingestion rate",
        view: cw.GraphWidgetView.TIME_SERIES,
        width: 12,
        left: [new cw.Metric({
          metricName: "IngestionDocumentRate",
          namespace: 'AWS/AOSS',
          statistic: cw.Stats.SUM,
          dimensionsMap: {
            ClientId: this.account,
            CollectionId: vectorDB.attrId,
            CollectionName: vectorDB.name,
            IndexId: aossIndexId,
            IndexName: "embeddings"
          }
        })],
      })
    );
    dashboardOS.addWidgets(
      new cw.GraphWidget({
        title: "Ingestion errors",
        view: cw.GraphWidgetView.TIME_SERIES,
        width: 12,
        left: [new cw.Metric({
          metricName: "IngestionDocumentErrors",
          namespace: 'AWS/AOSS',
          statistic: cw.Stats.SUM,
          dimensionsMap: {
            ClientId: this.account,
            CollectionId: vectorDB.attrId,
            CollectionName: vectorDB.name,
            IndexId: aossIndexId,
            IndexName: "embeddings"
          }
        })],
      }),
      new cw.GraphWidget({
        title: "Document data rate",
        view: cw.GraphWidgetView.TIME_SERIES,
        width: 12,
        left: [new cw.Metric({
          metricName: "IngestionDataRate",
          namespace: 'AWS/AOSS',
          statistic: cw.Stats.SUM,
          dimensionsMap: {
            ClientId: this.account,
            CollectionId: vectorDB.attrId,
            CollectionName: vectorDB.name,
            IndexId: aossIndexId,
            IndexName: "embeddings"
          }
        })],
      })
    );
    const dashboardSfn = new cw.Dashboard(this, 'L1DashboardSfn', {
      defaultInterval: cdk.Duration.days(7),
      dashboardName: "RAG_Layer_1-Component_Level-SFN"
    });
    dashboardSfn.addWidgets(new cw.TextWidget({
      markdown: '# Execution Metrics',
      width: 24
    }));
    dashboardSfn.node.addDependency(sfnPdfToText);
    dashboardSfn.addWidgets(
      new cw.GraphWidget({
        title: "Workflow run time",
        view: cw.GraphWidgetView.TIME_SERIES,
        width: 12,
        left: [new cw.Metric({
          metricName: "ExecutionTime",
          namespace: 'AWS/States',
          statistic: cw.Stats.AVERAGE,
          dimensionsMap: {
            StateMachineArn: sfnPdfToText.stateMachineArn
          }
        })],
      }),
      new cw.GraphWidget({
        title: "Workflows timed out",
        view: cw.GraphWidgetView.TIME_SERIES,
        width: 12,
        left: [new cw.Metric({
          metricName: "ExecutionsTimedOut",
          namespace: 'AWS/States',
          statistic: cw.Stats.SUM,
          dimensionsMap: {
            StateMachineArn: sfnPdfToText.stateMachineArn
          }
        })],
      })
    );
    dashboardSfn.addWidgets(
      new cw.GraphWidget({
        title: "Workflows started",
        view: cw.GraphWidgetView.TIME_SERIES,
        width: 12,
        left: [new cw.Metric({
          metricName: "ExecutionsStarted",
          namespace: 'AWS/States',
          statistic: cw.Stats.SUM,
          dimensionsMap: {
            StateMachineArn: sfnPdfToText.stateMachineArn
          }
        })],
      }),
      new cw.GraphWidget({
        title: "Workflows succeeded",
        view: cw.GraphWidgetView.TIME_SERIES,
        width: 12,
        left: [new cw.Metric({
          metricName: "ExecutionsSucceeded",
          namespace: 'AWS/States',
          statistic: cw.Stats.SUM,
          dimensionsMap: {
            StateMachineArn: sfnPdfToText.stateMachineArn
          }
        })],
      })
    );
    dashboardSfn.addWidgets(
      new cw.GraphWidget({
        title: "Workflows failed",
        view: cw.GraphWidgetView.TIME_SERIES,
        width: 8,
        left: [new cw.Metric({
          metricName: "ExecutionsFailed",
          namespace: 'AWS/States',
          statistic: cw.Stats.SUM,
          dimensionsMap: {
            StateMachineArn: sfnPdfToText.stateMachineArn
          }
        })],
      }),
      new cw.GraphWidget({
        title: "Workflows aborted",
        view: cw.GraphWidgetView.TIME_SERIES,
        width: 8,
        left: [new cw.Metric({
          metricName: "ExecutionsAborted",
          namespace: 'AWS/States',
          statistic: cw.Stats.SUM,
          dimensionsMap: {
            StateMachineArn: sfnPdfToText.stateMachineArn
          }
        })],
      }),
      new cw.GraphWidget({
        title: "Workflows throttled",
        view: cw.GraphWidgetView.TIME_SERIES,
        width: 8,
        left: [new cw.Metric({
          metricName: "ExecutionsThrottled",
          namespace: 'AWS/States',
          statistic: cw.Stats.SUM,
          dimensionsMap: {
            StateMachineArn: sfnPdfToText.stateMachineArn
          }
        })],
      })
    );
    const dashboardApp = new cw.Dashboard(this, 'L1DashboardApp', {
      defaultInterval: cdk.Duration.days(7),
      dashboardName: "RAG_Layer_1-Component_Level-App"
    });
    dashboardApp.addWidgets(new cw.TextWidget({
      markdown: '# Usage metrics (basic)',
      width: 24
    }));
    dashboardApp.node.addDependency(feService);
    dashboardApp.addWidgets(
      new cw.GraphWidget({
        title: "CPU Utilization",
        view: cw.GraphWidgetView.TIME_SERIES,
        width: 12,
        left: [new cw.Metric({
          metricName: "CPUUtilization",
          namespace: 'AWS/ECS',
          statistic: cw.Stats.AVERAGE,
          dimensionsMap: {
            ServiceName: feService.service.serviceName, 
            ClusterName: feService.cluster.clusterName
          }
        })],
      }),
      new cw.GraphWidget({
        title: "Memory utilization",
        view: cw.GraphWidgetView.TIME_SERIES,
        width: 12,
        left: [new cw.Metric({
          metricName: "MemoryUtilization",
          namespace: 'AWS/ECS',
          statistic: cw.Stats.AVERAGE,
          dimensionsMap: {
            ServiceName: feService.service.serviceName, 
            ClusterName: feService.cluster.clusterName
          }
        })],
      })
    );
    dashboardApp.addWidgets(new cw.TextWidget({
      markdown: '# Usage metrics (service)',
      width: 24
    }));
    dashboardApp.addWidgets(
      new cw.GraphWidget({
        title: "Desired task count",
        view: cw.GraphWidgetView.TIME_SERIES,
        width: 8,
        left: [new cw.Metric({
          metricName: "DesiredTaskCount",
          namespace: 'ECS/ContainerInsights',
          statistic: cw.Stats.AVERAGE,
          dimensionsMap: {
            ServiceName: feService.service.serviceName, 
            ClusterName: feService.cluster.clusterName
          }
        })],
      }),
      new cw.GraphWidget({
        title: "Running task count",
        view: cw.GraphWidgetView.TIME_SERIES,
        width: 8,
        left: [new cw.Metric({
          metricName: "RunningTaskCount",
          namespace: 'ECS/ContainerInsights',
          statistic: cw.Stats.AVERAGE,
          dimensionsMap: {
            ServiceName: feService.service.serviceName, 
            ClusterName: feService.cluster.clusterName
          }
        })],
      }),
      new cw.GraphWidget({
        title: "Pending task count",
        view: cw.GraphWidgetView.TIME_SERIES,
        width: 8,
        left: [new cw.Metric({
          metricName: "PendingTaskCount",
          namespace: 'ECS/ContainerInsights',
          statistic: cw.Stats.AVERAGE,
          dimensionsMap: {
            ServiceName: feService.service.serviceName, 
            ClusterName: feService.cluster.clusterName
          }
        })],
      })
    );
    dashboardApp.addWidgets(
      new cw.GraphWidget({
        title: "CPU utilized",
        view: cw.GraphWidgetView.TIME_SERIES,
        width: 12,
        left: [new cw.Metric({
          metricName: "CpuUtilized",
          namespace: 'ECS/ContainerInsights',
          statistic: cw.Stats.AVERAGE,
          dimensionsMap: {
            ServiceName: feService.service.serviceName, 
            ClusterName: feService.cluster.clusterName
          }
        })],
      }),
      new cw.GraphWidget({
        title: "Memory utilized",
        view: cw.GraphWidgetView.TIME_SERIES,
        width: 12,
        left: [new cw.Metric({
          metricName: "MemoryUtilized",
          namespace: 'ECS/ContainerInsights',
          statistic: cw.Stats.AVERAGE,
          dimensionsMap: {
            ServiceName: feService.service.serviceName, 
            ClusterName: feService.cluster.clusterName
          }
        })],
      })
    );
    dashboardApp.addWidgets(
      new cw.GraphWidget({
        title: "CPU reserved",
        view: cw.GraphWidgetView.TIME_SERIES,
        width: 12,
        left: [new cw.Metric({
          metricName: "CpuReserved",
          namespace: 'ECS/ContainerInsights',
          statistic: cw.Stats.AVERAGE,
          dimensionsMap: {
            ServiceName: feService.service.serviceName, 
            ClusterName: feService.cluster.clusterName
          }
        })],
      }),
      new cw.GraphWidget({
        title: "Memory reserved",
        view: cw.GraphWidgetView.TIME_SERIES,
        width: 12,
        left: [new cw.Metric({
          metricName: "MemoryReserved",
          namespace: 'ECS/ContainerInsights',
          statistic: cw.Stats.AVERAGE,
          dimensionsMap: {
            ServiceName: feService.service.serviceName, 
            ClusterName: feService.cluster.clusterName
          }
        })],
      })
    );
    dashboardApp.addWidgets(
      new cw.GraphWidget({
        title: "Network traffic in",
        view: cw.GraphWidgetView.TIME_SERIES,
        width: 12,
        left: [new cw.Metric({
          metricName: "NetworkRxBytes",
          namespace: 'ECS/ContainerInsights',
          statistic: cw.Stats.SUM,
          dimensionsMap: {
            ServiceName: feService.service.serviceName, 
            ClusterName: feService.cluster.clusterName
          }
        })],
      }),
      new cw.GraphWidget({
        title: "Network traffic out",
        view: cw.GraphWidgetView.TIME_SERIES,
        width: 12,
        left: [new cw.Metric({
          metricName: "NetworkTxBytes",
          namespace: 'ECS/ContainerInsights',
          statistic: cw.Stats.SUM,
          dimensionsMap: {
            ServiceName: feService.service.serviceName, 
            ClusterName: feService.cluster.clusterName
          }
        })],
      })
    );
    dashboardApp.addWidgets(
      new cw.GraphWidget({
        title: "Storage read",
        view: cw.GraphWidgetView.TIME_SERIES,
        width: 12,
        left: [new cw.Metric({
          metricName: "StorageReadBytes",
          namespace: 'ECS/ContainerInsights',
          statistic: cw.Stats.SUM,
          dimensionsMap: {
            ServiceName: feService.service.serviceName, 
            ClusterName: feService.cluster.clusterName
          }
        })],
      }),
      new cw.GraphWidget({
        title: "Storage written",
        view: cw.GraphWidgetView.TIME_SERIES,
        width: 12,
        left: [new cw.Metric({
          metricName: "StorageWriteBytes",
          namespace: 'ECS/ContainerInsights',
          statistic: cw.Stats.SUM,
          dimensionsMap: {
            ServiceName: feService.service.serviceName, 
            ClusterName: feService.cluster.clusterName
          }
        })],
      })
    );
    dashboardApp.addWidgets(
      new cw.GraphWidget({
        title: "Storage utilized",
        view: cw.GraphWidgetView.TIME_SERIES,
        width: 12,
        left: [new cw.Metric({
          metricName: "EphemeralStorageUtilized",
          namespace: 'ECS/ContainerInsights',
          statistic: cw.Stats.AVERAGE,
          dimensionsMap: {
            ServiceName: feService.service.serviceName, 
            ClusterName: feService.cluster.clusterName
          }
        })],
      }),
      new cw.GraphWidget({
        title: "Storage reserved",
        view: cw.GraphWidgetView.TIME_SERIES,
        width: 12,
        left: [new cw.Metric({
          metricName: "EphemeralStorageReserved",
          namespace: 'ECS/ContainerInsights',
          statistic: cw.Stats.AVERAGE,
          dimensionsMap: {
            ServiceName: feService.service.serviceName, 
            ClusterName: feService.cluster.clusterName
          }
        })],
      })
    );
    dashboardApp.addWidgets(new cw.TextWidget({
      markdown: '# Usage metrics (task)',
      width: 24
    }));
    dashboardApp.addWidgets(
      new cw.GraphWidget({
        title: "CPU utilization",
        view: cw.GraphWidgetView.TIME_SERIES,
        width: 12,
        left: [new cw.Metric({
          metricName: "CpuUtilized",
          namespace: 'ECS/ContainerInsights',
          statistic: cw.Stats.AVERAGE,
          dimensionsMap: {
            ClusterName: feService.cluster.clusterName,
            TaskDefinitionFamily: appTaskDefinition.family
          }
        })],
      }),
      new cw.GraphWidget({
        title: "Memory utilization",
        view: cw.GraphWidgetView.TIME_SERIES,
        width: 12,
        left: [new cw.Metric({
          metricName: "MemoryUtilized",
          namespace: 'ECS/ContainerInsights',
          statistic: cw.Stats.AVERAGE,
          dimensionsMap: {
            ClusterName: feService.cluster.clusterName,
            TaskDefinitionFamily: appTaskDefinition.family
          }
        })],
      })
    );
    dashboardApp.addWidgets(
      new cw.GraphWidget({
        title: "Network traffic received",
        view: cw.GraphWidgetView.TIME_SERIES,
        width: 12,
        left: [new cw.Metric({
          metricName: "NetworkRxBytes",
          namespace: 'ECS/ContainerInsights',
          statistic: cw.Stats.AVERAGE,
          dimensionsMap: {
            ClusterName: feService.cluster.clusterName,
            TaskDefinitionFamily: appTaskDefinition.family
          }
        })],
      }),
      new cw.GraphWidget({
        title: "Network traffic sent",
        view: cw.GraphWidgetView.TIME_SERIES,
        width: 12,
        left: [new cw.Metric({
          metricName: "NetworkTxBytes",
          namespace: 'ECS/ContainerInsights',
          statistic: cw.Stats.AVERAGE,
          dimensionsMap: {
            ClusterName: feService.cluster.clusterName,
            TaskDefinitionFamily: appTaskDefinition.family
          }
        })],
      })
    );
    dashboardApp.addWidgets(
      new cw.GraphWidget({
        title: "CPU reserved",
        view: cw.GraphWidgetView.TIME_SERIES,
        width: 12,
        left: [new cw.Metric({
          metricName: "CpuReserved",
          namespace: 'ECS/ContainerInsights',
          statistic: cw.Stats.AVERAGE,
          dimensionsMap: {
            ClusterName: feService.cluster.clusterName,
            TaskDefinitionFamily: appTaskDefinition.family
          }
        })],
      }),
      new cw.GraphWidget({
        title: "Memory reserved",
        view: cw.GraphWidgetView.TIME_SERIES,
        width: 12,
        left: [new cw.Metric({
          metricName: "MemoryReserved",
          namespace: 'ECS/ContainerInsights',
          statistic: cw.Stats.AVERAGE,
          dimensionsMap: {
            ClusterName: feService.cluster.clusterName,
            TaskDefinitionFamily: appTaskDefinition.family
          }
        })],
      })
    );
    dashboardApp.addWidgets(
      new cw.GraphWidget({
        title: "Storage traffic read",
        view: cw.GraphWidgetView.TIME_SERIES,
        width: 12,
        left: [new cw.Metric({
          metricName: "StorageReadBytes",
          namespace: 'ECS/ContainerInsights',
          statistic: cw.Stats.SUM,
          dimensionsMap: {
            ClusterName: feService.cluster.clusterName,
            TaskDefinitionFamily: appTaskDefinition.family
          }
        })],
      }),
      new cw.GraphWidget({
        title: "Storage traffic write",
        view: cw.GraphWidgetView.TIME_SERIES,
        width: 12,
        left: [new cw.Metric({
          metricName: "StorageWriteBytes",
          namespace: 'ECS/ContainerInsights',
          statistic: cw.Stats.SUM,
          dimensionsMap: {
            ClusterName: feService.cluster.clusterName,
            TaskDefinitionFamily: appTaskDefinition.family
          }
        })],
      })
    );
    dashboardApp.addWidgets(
      new cw.GraphWidget({
        title: "Storage utilized",
        view: cw.GraphWidgetView.TIME_SERIES,
        width: 12,
        left: [new cw.Metric({
          metricName: "EphemeralStorageUtilized",
          namespace: 'ECS/ContainerInsights',
          statistic: cw.Stats.AVERAGE,
          dimensionsMap: {
            ClusterName: feService.cluster.clusterName,
            TaskDefinitionFamily: appTaskDefinition.family
          }
        })],
      }),
      new cw.GraphWidget({
        title: "Storage reserved",
        view: cw.GraphWidgetView.TIME_SERIES,
        width: 12,
        left: [new cw.Metric({
          metricName: "EphemeralStorageReserved",
          namespace: 'ECS/ContainerInsights',
          statistic: cw.Stats.AVERAGE,
          dimensionsMap: {
            ClusterName: feService.cluster.clusterName,
            TaskDefinitionFamily: appTaskDefinition.family
          }
        })],
      })
    );

    const dashboardRagas = new cw.Dashboard(this, 'L4DashboardRagas', {
      defaultInterval: cdk.Duration.days(7),
      dashboardName: "RAG_Layer_4-Ragas"
    });
    dashboardRagas.addWidgets(new cw.TextWidget({
      markdown: '# Quality metrics',
      width: 24
    }));
    dashboardRagas.addWidgets(new cw.TableWidget({
      title: "Quality",
      width: 16,
      metrics: [
        new cw.Metric({
          metricName: "context_precision",
          namespace: 'ragas',
        }),
        new cw.Metric({
          metricName: "context_recall",
          namespace: 'ragas',
        }),
      ],
      summary: {
        columns: [cw.TableSummaryColumn.AVERAGE, cw.TableSummaryColumn.MAXIMUM, cw.TableSummaryColumn.MINIMUM],
        hideNonSummaryColumns: true,
        sticky: true,
      },
      thresholds: [
        cw.TableThreshold.below(0.7, cw.Color.RED),
        cw.TableThreshold.between(0.7, 0.85, cw.Color.ORANGE),
        cw.TableThreshold.above(0.85, cw.Color.GREEN),
      ],
    }));
    dashboardRagas.addWidgets(new cw.TextWidget({
      markdown: '# Trust and safety metrics',
      width: 24
    }));
    dashboardRagas.addWidgets(new cw.TableWidget({
      title: "Trust and safety",
      width: 16,
      metrics: [
        new cw.Metric({
          metricName: "harmfulness",
          namespace: 'ragas',
        }),
      ],
      summary: {
        columns: [cw.TableSummaryColumn.AVERAGE, cw.TableSummaryColumn.MAXIMUM, cw.TableSummaryColumn.MINIMUM],
        hideNonSummaryColumns: true,
        sticky: true,
      },
      thresholds: [
        cw.TableThreshold.below(0.1, cw.Color.GREEN),
        cw.TableThreshold.between(0.1, 0.4, cw.Color.ORANGE),
        cw.TableThreshold.above(0.4, cw.Color.RED),
      ],
    }));
    const dashboardFeedback = new cw.Dashboard(this, 'L4DashboardFeedback', {
      defaultInterval: cdk.Duration.days(7),
      dashboardName: "RAG_Layer_4-Feedback"
    });
    dashboardFeedback.addWidgets(new cw.TextWidget({
      markdown: '# Feedback metrics',
      width: 24
    }));
    dashboardFeedback.addWidgets(new cw.TableWidget({
      title: "Feedback",
      width: 16,
      metrics: [
        new cw.Metric({
          metricName: "rating",
          namespace: 'chatfeedback',
        }),
        new cw.Metric({
          metricName: "rating",
          namespace: 'ragfeedback',
        }),
      ],
      summary: {
        columns: [cw.TableSummaryColumn.AVERAGE, cw.TableSummaryColumn.MAXIMUM, cw.TableSummaryColumn.MINIMUM],
        hideNonSummaryColumns: true,
        sticky: true,
      },
      thresholds: [
        cw.TableThreshold.below(0.7, cw.Color.RED),
        cw.TableThreshold.between(0.7, 0.85, cw.Color.ORANGE),
        cw.TableThreshold.above(0.85, cw.Color.GREEN),
      ],
    }));

    // outputs
    new cdk.CfnOutput(this, 'CloudFrontDomain', {
      value: `https://${distribution.distributionDomainName}`
    });
    new cdk.CfnOutput(this, 'AppURL', {
      value: `https://${appCustomDomainName}`
    });
    new cdk.CfnOutput(this, 'BucketName', {
      value: contentBucket.bucketName
    });
    new cdk.CfnOutput(this, 'CfLogBucketName', {
      value: cfLogBucket.bucketName
    });
    new cdk.CfnOutput(this, 'BucketIngestPath', {
      value: `${contentBucket.bucketName}/ingest`
    });
    new cdk.CfnOutput(this, 'JumpHostId', {
      value: jumpHost.instanceId
    });
    new cdk.CfnOutput(this, 'VectorDBDashboard', {
      value: vectorDB.attrDashboardEndpoint
    });
    new cdk.CfnOutput(this, 'PrometheusEndpoint', {
      value: prometheus.attrPrometheusEndpoint
    });
    new cdk.CfnOutput(this, 'GrafanaEndpoint', {
      value: grafanaWs.attrEndpoint
    });
    new cdk.CfnOutput(this, 'DashboardBedrock', {
      value: dashboardBedrock.dashboardName
    });
    new cdk.CfnOutput(this, 'DashboardOpenSearch', {
      value: dashboardOS.dashboardName
    });
    new cdk.CfnOutput(this, 'DashboardSfn', {
      value: dashboardSfn.dashboardName
    });
    new cdk.CfnOutput(this, 'DashboardApp', {
      value: dashboardApp.dashboardName
    });
    new cdk.CfnOutput(this, 'DashboardRagas', {
      value: dashboardRagas.dashboardName
    });
    new cdk.CfnOutput(this, 'DashboardFeedback', {
      value: dashboardFeedback.dashboardName
    });
    new cdk.CfnOutput(this, 'MLFlow', {
      value: mlFlowServer.getAtt("TrackingServerArn").toString()
    });

    // cdk nag suppressions
    NagSuppressions.addResourceSuppressions(
      jumpHost,
      [
          { id: 'AwsSolutions-IAM4', reason: 'AwsSolutions-IAM4[Policy::arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore] indicates the role is using an AWS managed policy which does not currently restrict resource scope. Guidance is to replace with customer-managed policy, however the BastionHostLinux construct does not allow for assigning instance role after creation of the instance. That is to say, jumpHost.instance.role is a read-only property.',},
          { id: 'AwsSolutions-EC28', reason: 'The BastionHostLinux Construct does not allow for enablement of detailed monitoring.',},
          { id: 'AwsSolutions-EC29', reason: 'Autoscaling and termination protection are unnecessary for the bastion host for this project.',},
      ],
      true
  );
  }
}
