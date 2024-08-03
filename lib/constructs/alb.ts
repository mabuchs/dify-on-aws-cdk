import { Duration } from 'aws-cdk-lib';
import { Certificate, CertificateValidation } from 'aws-cdk-lib/aws-certificatemanager';
import { IVpc, Peer, Port, SubnetType } from 'aws-cdk-lib/aws-ec2';
import { FargateService, IService } from 'aws-cdk-lib/aws-ecs';
import {
  ApplicationListener,
  ApplicationLoadBalancer,
  ApplicationProtocol,
  ApplicationTargetGroup,
  ListenerAction,
  ListenerCondition,
  TargetType,
  UnauthenticatedAction,
} from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import { ARecord, IHostedZone, RecordTarget } from 'aws-cdk-lib/aws-route53';
import { LoadBalancerTarget } from 'aws-cdk-lib/aws-route53-targets';
import * as secrets_manager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';
import { Cognito } from './cognito';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { Runtime } from 'aws-cdk-lib/aws-lambda';
import { LambdaTarget } from 'aws-cdk-lib/aws-elasticloadbalancingv2-targets';
import { AuthenticateCognitoAction } from 'aws-cdk-lib/aws-elasticloadbalancingv2-actions';

export interface AlbProps {
  vpc: IVpc;
  allowedCidrs: string[];

  /**
   * @default 'dify'
   */
  subDomain?: string;

  /**
   * @default custom domain and TLS is not configured.
   */
  hostedZone?: IHostedZone;
}

export enum TargetGroup {
  API = 'Api',
  WEB = 'Web',
}

export class Alb extends Construct {
  public url: string;

  protected listenerPriority = 1;
  protected listener: ApplicationListener;
  protected vpc: IVpc;
  protected alb: ApplicationLoadBalancer;
  protected certificate?: Certificate;
  protected targetGroups: { [key: string]: ApplicationTargetGroup } = {};

  constructor(scope: Construct, id: string, props: AlbProps) {
    super(scope, id);

    const { vpc, subDomain = 'dify' } = props;
    const protocol = props.hostedZone ? ApplicationProtocol.HTTPS : ApplicationProtocol.HTTP;
    this.certificate = props.hostedZone
      ? new Certificate(this, 'Certificate', {
          domainName: `${subDomain}.${props.hostedZone.zoneName}`,
          validation: CertificateValidation.fromDns(props.hostedZone),
        })
      : undefined;

    this.alb = new ApplicationLoadBalancer(this, 'Resource', {
      vpc,
      vpcSubnets: vpc.selectSubnets({ subnets: vpc.publicSubnets }),
      internetFacing: true,
    });
    this.url = `${protocol.toLowerCase()}://${this.alb.loadBalancerDnsName}`;

    const listener = this.alb.addListener('Listener', {
      protocol,
      open: false,
      defaultAction: ListenerAction.fixedResponse(400),
      certificates: this.certificate ? [this.certificate] : undefined,
    });
    props.allowedCidrs.forEach((cidr) => listener.connections.allowDefaultPortFrom(Peer.ipv4(cidr)));

    if (props.hostedZone) {
      new ARecord(this, 'AliasRecord', {
        zone: props.hostedZone,
        recordName: subDomain,
        target: RecordTarget.fromAlias(new LoadBalancerTarget(this.alb)),
      });
      this.url = `${protocol.toLowerCase()}://${subDomain}.${props.hostedZone.zoneName}`;
    }

    this.vpc = vpc;
    this.listener = listener;
  }

  protected createTargetGroup(id: TargetGroup, port: number, healthCheckPath: string) {
    const group = new ApplicationTargetGroup(this, `${id}TargetGroup`, {
      vpc: this.vpc,
      protocol: ApplicationProtocol.HTTP,
      port,
      deregistrationDelay: Duration.seconds(10),
      healthCheck: {
        path: healthCheckPath,
        interval: Duration.seconds(15),
        healthyHttpCodes: '200-299,307',
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 6,
      },
    });
    this.targetGroups[id] = group;
    return group;
  }

  public addEcsService(
    id: TargetGroup,
    ecsService: FargateService,
    port: number,
    healthCheckPath: string,
    paths: string[],
  ) {
    const group = this.targetGroups[id] ?? this.createTargetGroup(id, port, healthCheckPath);
    group.addTarget(ecsService);
    // a condition only accepts an array with up to 5 elements
    // https://docs.aws.amazon.com/elasticloadbalancing/latest/application/load-balancer-limits.html
    for (let i = 0; i < Math.floor((paths.length + 4) / 5); i++) {
      const slice = paths.slice(i * 5, (i + 1) * 5);
      this.listener.addTargetGroups(`${id}${i}`, {
        targetGroups: [group],
        conditions: [ListenerCondition.pathPatterns(slice)],
        priority: this.listenerPriority++,
      });
    }
  }
}

export interface AuthorizedAlbProps extends AlbProps {
  /**
   * if defined, access requires cognito authentication
   */
  cognito: Cognito;
}

// AuthorizedAlb extends Alb
export class AuthorizedAlb extends Alb {
  constructor(scope: Construct, id: string, props: AuthorizedAlbProps) {
    super(scope, id, props);
    const { subDomain = 'dify' } = props;

    const { cognito, hostedZone } = props;

    if (!hostedZone) {
      throw new Error(`To enforce cognito authentication, You have to set hostedZone!`);
    }

    if (!this.certificate) {
      throw new Error(`To enforce cognito authentication, You have to set hostedZone and create certificate!`);
    }

    // create secret token in secrets manager
    const internalListenerTokenSecret = new secrets_manager.Secret(this, 'InternalListenerToken', {
      generateSecretString: {
        generateStringKey: 'token',
        secretStringTemplate: JSON.stringify({}),
        excludePunctuation: true,
      },
    });

    const internalListenerTokenString = internalListenerTokenSecret.secretValueFromJson('token').unsafeUnwrap();

    const authProxyLambda = new NodejsFunction(this, 'authProxyLambda', {
      entry: 'lib/constructs/lambda/lambda_proxy.ts',
      handler: 'handler',
      runtime: Runtime.NODEJS_LATEST,
      bundling: {
        externalModules: ['aws-sdk'],
      },
      environment: {
        INTERNAL_LISTENER_TOKEN: internalListenerTokenString,
        ALB_FQDN: `${subDomain}.${hostedZone.zoneName}`,
        UNAUTHORIZED_MESSAGE:
          'このチャットを利用するには認証が必要です。\n以下の URL をクリックして Amazon Cognito の認証を完了してください。',
        UNAUTHORIZED_TITLE: '未認証',
      },
      vpc: this.vpc,
      vpcSubnets: this.vpc.selectSubnets({ subnetType: SubnetType.PRIVATE_WITH_EGRESS }),
    });

    const lambdaTargetGroup = new ApplicationTargetGroup(this, 'LambdaTargetGroup', {
      targetType: TargetType.LAMBDA,
      targets: [new LambdaTarget(authProxyLambda)],
    });

    this.createTargetGroup(TargetGroup.API, 5001, '/health');
    this.createTargetGroup(TargetGroup.WEB, 3000, '/');

    // internal HTTPS リスナー
    const internalHttpsListener = this.alb.addListener('InternalHttpsListener', {
      port: 8443,
      protocol: ApplicationProtocol.HTTPS,
      certificates: [this.certificate],
      defaultAction: ListenerAction.fixedResponse(403),
    });

    // route initial api request to api if cognito authorized
    internalHttpsListener.addAction('InitialApiActionInternal', {
      action: new AuthenticateCognitoAction({
        userPool: props.cognito.userPool,
        userPoolClient: props.cognito.userPoolClient,
        userPoolDomain: props.cognito.userPoolDomain,
        next: ListenerAction.forward([this.targetGroups[TargetGroup.API]]),
        onUnauthenticatedRequest: UnauthenticatedAction.DENY,
      }),
      conditions: [
        ListenerCondition.pathPatterns(['/api/meta', '/api/parameters', '/api/conversations', '/api/site']),
        ListenerCondition.httpHeader('X-Internal-Auth', [internalListenerTokenString]),
      ],
      priority: 40,
    });

    // route /api/passport to api service without cognito auth
    this.listener.addAction('PassportApiAllowAction', {
      action: ListenerAction.forward([this.targetGroups[TargetGroup.API]]),
      conditions: [ListenerCondition.pathPatterns(['/api/passport'])],
      priority: 10,
    });

    // route static asset request to web without cognito auth
    this.listener.addAction('StaticAssetAction', {
      action: ListenerAction.forward([this.targetGroups[TargetGroup.WEB]]),
      conditions: [
        ListenerCondition.pathPatterns(['/embed.min.js', '/_next/static/*', 'favicon.ico', '/logo/logo-site.png']),
      ],
      priority: 20,
    });
    this.listener.addAction('ChatAssetAction', {
      action: ListenerAction.forward([this.targetGroups[TargetGroup.WEB]]),
      conditions: [ListenerCondition.pathPatterns(['/chat/*', '/chatbot/*'])],
      priority: 30,
    });

    // route initial api requests to lambda target
    this.listener.addAction('InitialApiAction', {
      action: ListenerAction.forward([lambdaTargetGroup]),
      conditions: [ListenerCondition.pathPatterns(['/api/meta', '/api/parameters', '/api/conversations', '/api/site'])],
      priority: 40,
    });

    // route v1 api requests to api target without authentication
    this.listener.addAction('V1ApiAction', {
      action: ListenerAction.forward([this.targetGroups[TargetGroup.API]]),
      conditions: [ListenerCondition.pathPatterns(['/v1/*'])],
      priority: 50,
    });

    // route other api requests to api target if cognito authorized
    this.listener.addAction('ApiAction', {
      action: new AuthenticateCognitoAction({
        userPool: cognito.userPool,
        userPoolClient: cognito.userPoolClient,
        userPoolDomain: cognito.userPoolDomain,
        next: ListenerAction.forward([this.targetGroups[TargetGroup.API]]),
        onUnauthenticatedRequest: UnauthenticatedAction.AUTHENTICATE,
      }),
      conditions: [ListenerCondition.pathPatterns(['/api/*', '/console/api/*', '/files/*'])],
      priority: 60,
    });

    // モックから認証させるための仮 URL
    this.listener.addAction('AuthResultMockAction', {
      action: new AuthenticateCognitoAction({
        userPool: cognito.userPool,
        userPoolClient: cognito.userPoolClient,
        userPoolDomain: cognito.userPoolDomain,
        next: ListenerAction.fixedResponse(200, {
          contentType: 'text/html',
          messageBody: '<html><body><h1>認証完了</h1><div>元のページに戻り、リロードしてください</div></body></html>',
        }),
        onUnauthenticatedRequest: UnauthenticatedAction.AUTHENTICATE,
      }),
      conditions: [ListenerCondition.pathPatterns(['/auth-result'])],
      priority: 70,
    });

    // route other request to web target if cognito authorized
    this.listener.addAction('WebAction', {
      action: new AuthenticateCognitoAction({
        userPool: cognito.userPool,
        userPoolClient: cognito.userPoolClient,
        userPoolDomain: cognito.userPoolDomain,
        next: ListenerAction.forward([this.targetGroups[TargetGroup.WEB]]),
        onUnauthenticatedRequest: UnauthenticatedAction.AUTHENTICATE,
      }),
    });
  }

  public addEcsService(
    id: TargetGroup,
    ecsService: FargateService,
    port: number,
    healthCheckPath: string,
    paths: string[],
  ) {
    const group = this.targetGroups[id] ?? this.createTargetGroup(id, port, healthCheckPath);
    group.addTarget(ecsService);
    return;
  }
}
