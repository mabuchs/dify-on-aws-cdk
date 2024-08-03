import { ALBEvent, ALBHandler } from 'aws-lambda';
import * as axios from 'axios';

export const handler: ALBHandler = async (event, context) => {
  console.log('event: ', event);

  console.log('header: ', event.headers);

  // return mock response if no header or no cookie,
  if (!event.headers || !event.headers.cookie) {
    console.log('headers or cookie not exist');
    return returnMock(event);
  }

  // parse cookie
  const cookies = event.headers.cookie.split(';').reduce((acc, curr) => {
    const [key, value] = curr.split('=');
    acc[key.trim()] = value;
    return acc;
  }, {} as Record<string, string>);
  console.log('cookies: ', cookies);

  // return mock response if AWSELBAuthSessionCookie-0 cookie not exists
  if (!cookies['AWSELBAuthSessionCookie-0']) {
    console.log('Not authorized by cognito');
    return returnMock(event);
  }

  const fqdn = process.env.ALB_FQDN;
  try {
    const internalAlbResponse = await forward(event, `${fqdn}:8443`);
    console.log(internalAlbResponse);
    console.log(internalAlbResponse.request);
    console.log(internalAlbResponse.data);
    return {
      statusCode: internalAlbResponse.status,
      body: JSON.stringify(internalAlbResponse.data),
      isBase64Encoded: false,
      headers: {
        'Content-Type': 'application/json',
      },
    };
  } catch (error) {
    console.log(error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error }),
      isBase64Encoded: false,
      headers: {
        'Content-Type': 'application/json',
      },
    };
  }
};

async function forward(event: ALBEvent, target: string) {
  const axiosConfig: axios.AxiosRequestConfig = {
    method: event.httpMethod,
    url: `https://${target}${event.path}`,
    headers: {
      ...event.headers,
      'X-Internal-Auth': process.env.INTERNAL_LISTENER_TOKEN,
    },
    data: event.body,
    params: event.queryStringParameters,
  };
  console.log(axiosConfig);
  const forwardedResponse = await axios.default.request(axiosConfig);
  return forwardedResponse;
}

// function returnMock(event)
function returnMock(event: ALBEvent) {
  const response = mockResponses[event.path];
  return {
    statusCode: 200,
    body: JSON.stringify(response),
    isBase64Encoded: false,
    headers: {
      'Content-Type': 'application/json',
    },
  };
}

// mock responses to paths
// paths are: '/api/meta', '/api/parameters', '/api/conversations', '/api/site', '/api/passport'
const mockResponses = {
  '/api/meta': {
    tool_icons: {},
  },
  '/api/parameters': {
    opening_statement: `${process.env.UNAUTHORIZED_MESSAGE}\nhttps://${process.env.ALB_FQDN}/auth-result`,
    suggested_questions: [],
    suggested_questions_after_answer: {
      enabled: false,
    },
    speech_to_text: {
      enabled: false,
    },
    text_to_speech: {
      enabled: false,
      voice: '',
      language: '',
    },
    retriever_resource: {
      enabled: true,
    },
    annotation_reply: {
      enabled: false,
    },
    more_like_this: {
      enabled: false,
    },
    user_input_form: [],
    sensitive_word_avoidance: {
      enabled: false,
      type: '',
      configs: [],
    },
    file_upload: {
      image: {
        enabled: false,
      },
    },
    system_parameters: {
      image_file_size_limit: '10',
    },
  },
  '/api/conversations': {
    limit: 100,
    has_more: false,
    data: [],
  },
  '/api/site': {
    app_id: generateUUID(), // random uuid
    end_user_id: generateUUID(),
    enable_site: true,
    site: {
      title: process.env.UNAUTHORIZED_TITLE,
      chat_color_theme: null,
      chat_color_theme_inverted: false,
      icon: '\ud83e\udd16',
      icon_background: '#FFEAD5',
      description: null,
      copyright: null,
      privacy_policy: null,
      custom_disclaimer: null,
      default_language: 'en-US',
      prompt_public: false,
      show_workflow_steps: true,
    },
    model_config: null,
    plan: 'basic',
    can_replace_logo: false,
    custom_config: null,
  },
  '/api/passport': {
    access_token: 'mock',
  },
} as Record<string, any>;

// function to generate uuid
function generateUUID() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
    var r = (Math.random() * 16) | 0,
      v = c == 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}
