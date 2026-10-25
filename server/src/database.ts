import { initializeDnsServers } from './dns-init.js';

export type DatabaseModules = {
  mongoose: typeof import('mongoose').default;
  Mystery: typeof import('./model.js').Mystery;
};

/** Configure c-ares first, then load Mongoose and its models. */
export async function loadDatabaseModules(): Promise<DatabaseModules> {
  initializeDnsServers();

  // These dynamic imports deliberately happen after initializeDnsServers().
  const mongooseModule = await import('mongoose');
  const modelModule = await import('./model.js');

  return { mongoose: mongooseModule.default, Mystery: modelModule.Mystery };
}
