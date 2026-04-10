import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { GarminClient } from '../client';
import {
  registerActivityTools,
  registerHealthTools,
  registerTrendTools,
  registerSleepTools,
  registerBodyTools,
  registerPerformanceTools,
  registerProfileTools,
  registerRangeTools,
  registerSnapshotTools,
  registerTrainingTools,
  registerWellnessTools,
  registerChallengeTools,
  registerWriteTools,
} from '../tools';

const WRITE_TOOL_NAMES = new Set([
  'set_activity_name',
  'create_manual_activity',
  'delete_activity',
  'add_weigh_in',
  'set_hydration',
  'set_blood_pressure',
  'add_gear_to_activity',
  'remove_gear_from_activity',
]);

export type CreateGarminServerOptions = {
  enableWriteTools?: boolean;
};

function applyToolAnnotations(server: McpServer): void {
  const mutableServer = server as unknown as {
    registerTool: (name: string, config: Record<string, unknown>, handler: unknown) => unknown;
  };
  const originalRegisterTool = mutableServer.registerTool.bind(server);

  mutableServer.registerTool = (name: string, config: Record<string, unknown>, handler: unknown) => {
    const isWriteTool = WRITE_TOOL_NAMES.has(name);
    const mergedConfig = {
      ...config,
      annotations: {
        ...(config?.annotations as Record<string, unknown> | undefined),
        readOnlyHint: !isWriteTool,
        destructiveHint: isWriteTool,
      },
    };

    return originalRegisterTool(name, mergedConfig, handler);
  };
}

export function createGarminServer(
  email: string,
  password: string,
  options?: CreateGarminServerOptions,
): McpServer {
  const server = new McpServer({
    name: 'garmin-connect-mcp',
    version: '1.0.0',
  });

  applyToolAnnotations(server);

  const client = new GarminClient(email, password);

  registerActivityTools(server, client);
  registerHealthTools(server, client);
  registerTrendTools(server, client);
  registerSleepTools(server, client);
  registerBodyTools(server, client);
  registerPerformanceTools(server, client);
  registerProfileTools(server, client);
  registerRangeTools(server, client);
  registerSnapshotTools(server, client);
  registerTrainingTools(server, client);
  registerWellnessTools(server, client);
  registerChallengeTools(server, client);

  if (options?.enableWriteTools) {
    registerWriteTools(server, client);
  }

  return server;
}
