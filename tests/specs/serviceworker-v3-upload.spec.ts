// @ts-nocheck

import { test, expect } from './fixtures';

const V3_ENDPOINT = 'http://localhost:9090/v3/data/bundle'
const V3_EMPTY_REPLY_ENDPOINT = 'http://localhost:9090/v3/data/bundle-empty-reply'

// Reconfigure the module in-place rather than editing tests/extension/config.json,
// which the POST specs share.
//
// setup() -> refreshConfiguration() drains the queue on its own, so the event is
// logged only after reconfiguring and the upload is retried until a bundle
// actually goes out. Otherwise the setup-triggered POST empties the queue first
// and this asserts against an empty response set.
const uploadWithConfiguration = (serviceWorker, configuration) => {
  return serviceWorker.evaluate(async (pdkConfiguration) => {
    const sleep = (ms) => new Promise((wake) => setTimeout(wake, ms))

    await sleep(2000)

    self.rexPDKPlugin.updateConfiguration(pdkConfiguration)

    await new Promise((logged) => {
      self.rexCorePlugin.handleMessage({
        'messageType': 'logEvent',
        'event': {
          'name': 'rex-pdk-v3-test'
        }
      }, this, () => {
        logged(undefined)
      })
    })

    for (let attempt = 0; attempt < 10; attempt++) {
      await sleep(500)

      // A concurrent upload holds the serialization guard; reconfigure each
      // attempt so a refresh in between cannot revert the endpoint.
      self.rexPDKPlugin.updateConfiguration(pdkConfiguration)

      try {
        const response = await self.rexPDKPlugin.uploadQueuedDataPoints(() => {})

        if (Array.isArray(response) && response.length > 0) {
          return { ok: true, response }
        }
      } catch (error) {
        return { ok: false, error: `${error}` }
      }
    }

    return { ok: false, error: 'no bundle was uploaded after 10 attempts' }
  }, configuration)
}

test('v3 configuration uploads via PUT with a bearer token', async ({ serviceWorker }) => {
  const result = await uploadWithConfiguration(serviceWorker, {
    identifier: 'rex-pdk-v3',
    endpoint: V3_ENDPOINT,
    endpoint_version: 'v3',
    authorization: { token: 'test-bearer-token' }
  })

  expect(result.ok, `upload failed: ${result.error}`).toBe(true)

  const reply = result.response[0]

  expect(reply['request-headers']['content-encoding']).toEqual('gzip')
  expect(reply['request-headers']['authorization']).toEqual('Bearer test-bearer-token')
  expect(reply['request-headers']['x-pdk-identifier']).toEqual('rex-pdk-v3')

  const loggedPoint = reply.payload.find((point) => point['passive-data-metadata']['generator-id'] === 'rex-pdk-v3-test')

  expect(loggedPoint, 'the logged event point was not in the bundle').toBeDefined()

  const metadata = loggedPoint['passive-data-metadata']

  expect(metadata.source).toEqual('rex-pdk-v3')
  expect(typeof metadata['enqueued-at']).toEqual('number')

  // enqueuedAt is promoted into metadata and removed from the point body.
  expect(loggedPoint.enqueuedAt).toBeUndefined()
})

test('v3 configuration without a bearer token fails instead of falling back to POST', async ({ serviceWorker }) => {
  const result = await uploadWithConfiguration(serviceWorker, {
    identifier: 'rex-pdk-v3',
    endpoint: V3_ENDPOINT,
    endpoint_version: 'v3'
  })

  expect(result.ok).toBe(false)
  expect(result.error).toContain('authorization.token')
})

test('v3 upload treats an empty 2xx reply as success', async ({ serviceWorker }) => {
  const result = await uploadWithConfiguration(serviceWorker, {
    identifier: 'rex-pdk-v3',
    endpoint: V3_EMPTY_REPLY_ENDPOINT,
    endpoint_version: 'v3',
    authorization: { token: 'test-bearer-token' }
  })

  expect(result.ok, `upload failed: ${result.error}`).toBe(true)
  expect(result.response[0].added).toBe(true)
})
