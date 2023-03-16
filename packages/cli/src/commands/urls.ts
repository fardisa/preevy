import yaml from 'yaml'
import { Args, ux } from '@oclif/core'
import DriverCommand from '../driver-command'
import { sshKeysStore } from '../lib/state/ssh'
import { nodeSshClient } from '../lib/ssh/client'
import { envIdFlags, findAmbientEnvId, findAmbientProjectName } from '../lib/env-id'
import { findDockerProxyUrl, minimalModelWithDockerProxyService, queryTunnels } from '../lib/docker-proxy-client'
import { localComposeClient } from '../lib/compose/client'
import { composeFlags } from '../lib/compose/flags'
import { flattenTunnels, FlatTunnel } from '../lib/tunneling'
import { wrapWithDockerSocket } from '../lib/commands/up/docker'

export default class Urls extends DriverCommand<typeof Urls> {
  static description = 'Show urls for an existing environment'

  static flags = {
    ...envIdFlags,
    ...composeFlags,
    ...ux.table.flags(),
  }

  static enableJsonFlag = true

  static args = {
    service: Args.string({
      description: 'Service name. If not specified, will show all services',
      required: false,
    }),
    port: Args.integer({
      description: 'Service port. If not specified, will show all ports for the specified service',
      required: false,
    }),
  }

  async run(): Promise<unknown> {
    const log = this.logger
    const { flags, args } = await this.parse(Urls)
    const driver = await this.machineDriver()
    const keyAlias = await driver.getKeyPairAlias()

    const keyStore = sshKeysStore(this.store)
    const sshKey = await keyStore.getKey(keyAlias)
    if (!sshKey) {
      throw new Error(`No key pair found for alias ${keyAlias}`)
    }

    const projectName = flags.project || await findAmbientProjectName(localComposeClient(flags.file))
    log.debug(`project: ${projectName}`)
    const envId = flags.id || await findAmbientEnvId(projectName)
    log.debug(`envId: ${envId}`)

    const machine = await driver.getMachine({ envId })
    if (!machine) {
      throw new Error(`No machine found for envId ${envId}`)
    }

    const sshClient = await nodeSshClient({
      host: machine.publicIPAddress,
      username: machine.sshUsername,
      privateKey: sshKey.privateKey.toString('utf-8'),
      log,
    })

    try {
      const compose = localComposeClient(Buffer.from(yaml.stringify(minimalModelWithDockerProxyService(projectName))))

      const withDockerSocket = wrapWithDockerSocket({ sshClient, log })

      const dockerProxyServiceUrl = await withDockerSocket(() => findDockerProxyUrl(compose))
      log.debug(`dockerProxyServiceUrl: ${dockerProxyServiceUrl}`)
      const { tunnels } = await queryTunnels(sshClient, dockerProxyServiceUrl)

      const flatTunnels: FlatTunnel[] = flattenTunnels(tunnels)
        .filter(tunnel => !args.service || (
          tunnel.service === args.service && (!args.port || tunnel.port === args.port)
        ))

      if (flags.json) {
        return flatTunnels
      }

      this.log(`Preview environment ${envId} provisioned: ${machine.publicIPAddress}`)

      ux.table(
        flatTunnels,
        {
          service: { header: 'Service' },
          port: { header: 'Port' },
          url: { header: 'URL' },
        },
        this.flags,
      )

      return undefined
    } finally {
      sshClient.dispose()
    }
  }
}