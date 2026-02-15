import os from 'node:os';
import path from 'node:path';

export interface ServiceDefinition {
  serviceType: string;
  name: string;
  defaultPath: string;
  patterns: string[];
}

export const SERVICE_DEFINITIONS: Record<string, ServiceDefinition> = {
  'claude-code': {
    serviceType: 'claude-code',
    name: 'Claude Code',
    defaultPath: path.join(os.homedir(), '.claude'),
    patterns: [
      'commands/**',
      'projects/**',
      'skills/**',
      'CLAUDE.md',
      'settings.json',
      'scripts/**',
    ],
  },
};

// Runtime registry for custom service definitions (populated from DB on startup)
const customDefinitions: Record<string, ServiceDefinition> = {};

export function registerCustomDefinition(def: ServiceDefinition): void {
  // Custom services store all patterns in service_settings (source: custom),
  // so the definition keeps an empty patterns array to avoid duplication
  // when getServiceEffectivePatterns merges def.patterns as "default".
  customDefinitions[def.serviceType] = { ...def, patterns: [] };
}

export function getServiceDefinition(serviceType: string): ServiceDefinition | undefined {
  return SERVICE_DEFINITIONS[serviceType] || customDefinitions[serviceType];
}

export function getAllServiceDefinitions(): ServiceDefinition[] {
  return [...Object.values(SERVICE_DEFINITIONS), ...Object.values(customDefinitions)];
}

export function getServiceStorePath(serviceType: string): string {
  return `services/${serviceType}`;
}
