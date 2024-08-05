import { Construct } from 'constructs';
import * as cdk from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import { IHostedZone } from 'aws-cdk-lib/aws-route53';

export interface CognitoProps {
  /**
   * Hosted zone to be used for ALB
   */
  hostedZone: IHostedZone;
  /**
   * subdomain
   */
  subDomain: string;
  /**
   *
   */
  cognitoDomainPrefix: string;
}

export class Cognito extends Construct {
  public readonly userPool: cognito.UserPool;
  public readonly userPoolClient: cognito.UserPoolClient;
  public readonly userPoolDomain: cognito.UserPoolDomain;

  constructor(scope: Construct, id: string, props: CognitoProps) {
    super(scope, id);
    const { subDomain: subdomain, hostedZone, cognitoDomainPrefix } = props;

    this.userPool = new cognito.UserPool(this, 'CognitoUserPool', {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      signInAliases: {
        email: true,
      },
      selfSignUpEnabled: true,
      userVerification: {},
      standardAttributes: {
        email: {
          required: true,
          mutable: false,
        },
      },
    });

    this.userPoolDomain = this.userPool.addDomain('CognitoAuthDomain', {
      cognitoDomain: {
        domainPrefix: cognitoDomainPrefix,
      },
    });

    this.userPoolClient = this.userPool.addClient('CognitoClient', {
      userPoolClientName: 'dify',
      generateSecret: true,
      authFlows: {
        userSrp: true,
        userPassword: true,
      },
      oAuth: {
        callbackUrls: [`https://${subdomain}.${hostedZone.zoneName}/oauth2/idpresponse`],
        scopes: [cognito.OAuthScope.EMAIL, cognito.OAuthScope.OPENID, cognito.OAuthScope.PROFILE],
        flows: {
          authorizationCodeGrant: true,
        },
      },
    });
  }
}
