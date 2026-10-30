import type { FastifyPluginAsync } from 'fastify'
import { BadRequestError, ConflictError } from '../errors.ts'
import { API_KEY_NAMES, type ApiKeyName } from '../services/api-keys.ts'

interface NameParams {
  name: ApiKeyName
}

const nameParams = {
  type: 'object',
  required: ['name'],
  properties: { name: { type: 'string', enum: [...API_KEY_NAMES] } },
}

export const settingsRoutes: FastifyPluginAsync = async (app) => {
  // In env-supplied mode the deployment owns every setting, API keys included, so a restart or
  // redeploy cannot disagree with what someone typed into the UI. A key the environment does
  // supply is read-only in either mode.
  function editable(name: ApiKeyName): boolean {
    return app.runtime.configMode === 'self-configured' && app.apiKeys.source(name) !== 'env'
  }

  function refuseIfNotEditable(name: ApiKeyName): void {
    if (editable(name)) return
    throw new ConflictError(
      `${name} is managed through the server's environment and cannot be changed here`,
    )
  }

  // Reports where each key comes from and whether it can be changed, never its value.
  app.get('/', async () => ({
    configMode: app.runtime.configMode ?? 'env-supplied',
    apiKeys: API_KEY_NAMES.map((name) => ({
      name,
      source: app.apiKeys.source(name),
      editable: editable(name),
    })),
  }))

  app.put<{ Params: NameParams; Body: { value: string } }>(
    '/api-keys/:name',
    {
      schema: {
        params: nameParams,
        body: {
          type: 'object',
          required: ['value'],
          properties: { value: { type: 'string', maxLength: 512 } },
        },
      },
    },
    async (req, reply) => {
      const { name } = req.params
      const value = req.body.value.trim()
      if (!value) throw new BadRequestError('The key cannot be empty')
      refuseIfNotEditable(name)
      app.appSecrets.set(req.session.user!.tenantId, name, value)
      return reply.status(204).send()
    },
  )

  app.delete<{ Params: NameParams }>(
    '/api-keys/:name',
    { schema: { params: nameParams } },
    async (req, reply) => {
      const { name } = req.params
      // A key stored before the deployment became env-managed can still be removed, never changed.
      if (app.apiKeys.source(name) === 'env') refuseIfNotEditable(name)
      app.appSecrets.delete(req.session.user!.tenantId, name)
      return reply.status(204).send()
    },
  )
}
