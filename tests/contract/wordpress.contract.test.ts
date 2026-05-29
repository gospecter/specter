import { WordPressAdapter } from '../../src/wordpress/adapter.js';
import { FakeWordPressApi } from '../fakes/FakeWordPressApi.js';
import { runCmsAdapterContract } from './cmsAdapter.contract.js';

runCmsAdapterContract(
  'WordPress',
  async () => {
    const api = new FakeWordPressApi();
    return new WordPressAdapter(api, 'https://fake.example.com');
  },
  { optimisticLock: true, containers: 'flat' },
);
