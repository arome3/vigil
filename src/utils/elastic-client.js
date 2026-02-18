import 'dotenv/config';
import { Client } from '@elastic/elasticsearch';

const clientOptions = {};

if (process.env.ELASTIC_URL) {
  clientOptions.node = process.env.ELASTIC_URL;
} else if (process.env.ELASTIC_CLOUD_ID) {
  clientOptions.cloud = { id: process.env.ELASTIC_CLOUD_ID };
}

if (process.env.ELASTIC_API_KEY) {
  clientOptions.auth = { apiKey: process.env.ELASTIC_API_KEY };
}

const client = new Client(clientOptions);

export default client;

export async function testConnection() {
  const info = await client.info();
  return info;
}
