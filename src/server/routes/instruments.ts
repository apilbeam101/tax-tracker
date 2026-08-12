import type { FastifyPluginAsync } from 'fastify'
import type { CreateInstrumentBody, UpdateInstrumentBody } from '../../shared/types.ts'

const INSTRUMENT_TYPES = ['equity', 'fund', 'etf', 'reit']
const RSU_METHODS = ['net-settlement', 'sell-to-cover', 'cash']

export const instrumentRoutes: FastifyPluginAsync = async (app) => {
  app.get('/', async (req) => {
    const user = req.session.user!
    return app.instruments.list(user.tenantId)
  })

  app.get<{ Params: { id: string } }>('/:id', async (req, reply) => {
    const user = req.session.user!
    const instrument = app.instruments.getById(user.tenantId, parseInt(req.params.id, 10))
    if (!instrument) return reply.status(404).send({ error: 'Not found' })
    return instrument
  })

  app.post<{ Body: CreateInstrumentBody }>(
    '/',
    {
      schema: {
        body: {
          type: 'object',
          required: ['ticker', 'name', 'currency'],
          properties: {
            ticker: { type: 'string', minLength: 1, maxLength: 32 },
            isin: { type: 'string', pattern: '^[A-Z]{2}[A-Z0-9]{10}$' },
            name: { type: 'string', minLength: 1, maxLength: 256 },
            currency: { type: 'string', minLength: 3, maxLength: 3 },
            exchange: { type: 'string', maxLength: 32 },
            instrumentType: { type: 'string', enum: INSTRUMENT_TYPES },
            isEmployerStock: { type: 'boolean' },
            rsuWithholdingMethod: { type: 'string', enum: RSU_METHODS },
            notes: { type: 'string', maxLength: 2048 },
          },
        },
      },
    },
    async (req, reply) => {
      const user = req.session.user!
      try {
        const instrument = app.instruments.create(user.tenantId, req.body, user.id)
        return reply.status(201).send(instrument)
      } catch (err) {
        const msg = (err as Error).message
        if (msg.includes('UNIQUE'))
          return reply.status(409).send({ error: 'Ticker already exists' })
        throw err
      }
    },
  )

  app.patch<{ Params: { id: string }; Body: UpdateInstrumentBody }>(
    '/:id',
    {
      schema: {
        body: {
          type: 'object',
          properties: {
            ticker: { type: 'string', minLength: 1, maxLength: 32 },
            isin: { type: 'string', pattern: '^[A-Z]{2}[A-Z0-9]{10}$' },
            name: { type: 'string', minLength: 1, maxLength: 256 },
            currency: { type: 'string', minLength: 3, maxLength: 3 },
            exchange: { type: 'string', maxLength: 32 },
            instrumentType: { type: 'string', enum: INSTRUMENT_TYPES },
            isEmployerStock: { type: 'boolean' },
            rsuWithholdingMethod: { type: 'string', enum: RSU_METHODS },
            notes: { type: 'string', maxLength: 2048 },
          },
        },
      },
    },
    async (req, reply) => {
      const user = req.session.user!
      const instrument = app.instruments.update(
        user.tenantId,
        parseInt(req.params.id, 10),
        req.body,
        user.id,
      )
      if (!instrument) return reply.status(404).send({ error: 'Not found' })
      return instrument
    },
  )

  app.delete<{ Params: { id: string } }>('/:id', async (req, reply) => {
    const user = req.session.user!
    const deleted = app.instruments.delete(user.tenantId, parseInt(req.params.id, 10), user.id)
    if (!deleted) return reply.status(404).send({ error: 'Not found' })
    return reply.status(204).send()
  })
}
