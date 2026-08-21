import { test, expect } from './fixtures';

// Pins the defect fixed in 6341080: persisting a point with
// `objectStore.add(point)` handed the raw object to the structured clone
// algorithm, which copies only own enumerable properties. A rex-types
// `DateString` keeps its instant in a `Temporal.Instant` from
// @js-temporal/polyfill, whose state lives in private slots, so the clone wrote
// `{ value: {}, originalValue: '' }` and the timestamp was gone. Nothing raised
// DataCloneError, so the point persisted, uploaded, and arrived at the server
// looking well formed. rex-spider-chatgpt writes three DateStrings per
// conversation and all of them arrived empty.
//
// The point travels the queued path a real producer uses, because that is the
// only path the defect lives on: `transmitSynchronousEvent` goes straight to
// `transmitDataPoint` and never reaches `objectStore.add`, so a test built on
// it would pass with or without the fix.

// Epoch seconds, the form ChatGPT emits and DateString accepts.
const CONVERSATION_EPOCH_SECONDS = 1777570208.089697

// What a DateString holding that instant serializes to. Written out rather than
// derived from the instance under test, so a change in either the type or the
// serialization fails here instead of agreeing with itself.
const CONVERSATION_INSTANT = '2026-04-30T17:30:08.089696768Z'

// stampPointMetadata derives `passive-data-metadata.timestamp` as `date / 1000`,
// so pinning `date` is what makes the point retrievable from the server.
const POINT_DATE_MS = 1777570208089
const POINT_TIMESTAMP = POINT_DATE_MS / 1000

const GENERATOR_ID = 'datestring-server-test'

// PDK uploads only when asked, and rejects until its database is open and its
// configuration has arrived. Retrying absorbs that startup window without the
// test inspecting the module to find out when it has passed.
const fetchPointsFromServer = async (serviceWorker, request) => {
  const deadline = Date.now() + 20000

  for (;;) {
    await serviceWorker.evaluate(() => {
      return self.rexPDKPlugin.uploadQueuedDataPoints(() => {}).then(() => undefined, () => undefined)
    })

    const response = await request.get(`/data/points.json?timestamp=${POINT_TIMESTAMP}`)

    expect(response.ok()).toBeTruthy()

    const body = await response.json()

    if (body.count > 0 || Date.now() > deadline) {
      return body
    }

    await new Promise((resolve) => setTimeout(resolve, 250))
  }
}

// A point dispatched before rex-core has a configuration is dropped:
// enqueueDataPoint hands the undefined configuration to normalizeConfiguration
// and the resulting rejection takes the point with it. rex-core's own
// fetchConfiguration is the public signal for when that window has closed.
const waitForConfiguration = (serviceWorker) => {
  return serviceWorker.evaluate(() => {
    return new Promise<void>((resolve, reject) => {
      const deadline = Date.now() + 10000

      const poll = () => {
        self.rexCorePlugin.fetchConfiguration()
          .then((configuration) => {
            if (configuration !== undefined && configuration['passive_data_kit'] !== undefined) {
              resolve()
            } else if (Date.now() > deadline) {
              reject(new Error('Timed out waiting for a configuration carrying passive_data_kit.'))
            } else {
              self.setTimeout(poll, 100)
            }
          })
      }

      poll()
    })
  })
}

test('a dispatched DateString reaches the server as the instant, not an empty object', async ({serviceWorker, request}) => {
  await waitForConfiguration(serviceWorker)

  await serviceWorker.evaluate(({ generatorId, epochSeconds, dateMs }) => {
    self.dispatchEvent({
      name: generatorId,
      date: dateMs,
      started: new self.DateString(epochSeconds),
      ended: new self.DateString(epochSeconds)
    })
  }, { generatorId: GENERATOR_ID, epochSeconds: CONVERSATION_EPOCH_SECONDS, dateMs: POINT_DATE_MS })

  const body = await fetchPointsFromServer(serviceWorker, request)

  expect(body.count).toEqual(1)

  const received = body.points[0]

  expect(received['passive-data-metadata']['generator-id']).toEqual(GENERATOR_ID)
  expect(received['started']).toEqual(CONVERSATION_INSTANT)
  expect(received['ended']).toEqual(CONVERSATION_INSTANT)
})
