import type { ProviderConnectionConfiguration } from '@openagent/contracts'
import { ProviderConnections } from '@openagent/plugin-kit/main'
import mock from '@openagent/provider-mock/main'

/** Fixture convenience using the real Provider binding path, not a second injection implementation. */
export function mockProviderAccess(harnessId: string, configuration: Partial<Omit<ProviderConnectionConfiguration, 'providerId'>> = {}) {
  const connection = { id: 'fixture', apiKey: 'openagent-mock-key', baseUrl: 'http://127.0.0.1:12345', ...configuration, providerId: 'mock' }
  const connections = new ProviderConnections([mock], [connection])
  const target = mock.descriptor.harnesses.find(entry => entry.harnessId === harnessId)
  if (!target) throw new Error('Unsupported mock Harness')
  return connections.forHarness(target, connection.id)
}
