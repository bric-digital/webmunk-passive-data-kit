import { test, expect } from './fixtures';

// These tests pin the defect fixed in 6341080: persisting a point with
// `objectStore.add(point)` handed the raw object to the structured clone
// algorithm, which copies only own enumerable properties. A rex-types
// `DateString` holds its instant in a `Temporal.Instant` from
// @js-temporal/polyfill, whose state lives in private slots, so the clone
// wrote `{ value: {}, originalValue: '' }` and the timestamp was gone.
//
// Nothing raised DataCloneError. The point persisted, uploaded, and arrived at
// the server looking well formed, which is why this ran unnoticed. Asserting on
// the value is the only thing that catches it.
//
// rex-spider-chatgpt writes three DateStrings per conversation (`started`,
// `ended`, and `when` on every turn), and all of them arrived empty.
//
// The tests use the real DateString rather than a local stand-in. A stand-in
// can only encode what we already believe the type does; if DateString or the
// polyfill changes shape, an imitation keeps passing while collection breaks.

// Epoch seconds, the form ChatGPT emits and DateString accepts.
const CONVERSATION_EPOCH_SECONDS = 1777570208.089697

// stampPointMetadata derives `passive-data-metadata.timestamp` as `date / 1000`,
// so pinning `date` is what lets the server-side test retrieve this point.
const POINT_DATE_MS = 1777570208089
const POINT_TIMESTAMP = POINT_DATE_MS / 1000

const dispatchConversationPoint = (serviceWorker, generatorId: string) => {
  return serviceWorker.evaluate(async ({ generatorId, epochSeconds, dateMs }) => {
    const pdk = self.rexPDKPlugin

    const waitFor = (condition: () => boolean, timeoutMs: number, label: string) => {
      return new Promise<void>((resolve, reject) => {
        const started = Date.now()

        const poll = () => {
          if (condition()) {
            resolve()
          } else if (Date.now() - started > timeoutMs) {
            reject(new Error(`Timed out waiting for: ${label}`))
          } else {
            self.setTimeout(poll, 25)
          }
        }

        poll()
      })
    }

    const countPoints = () => {
      return new Promise<number>((resolve) => {
        const request = pdk.database.transaction(['dataPoints'], 'readonly').objectStore('dataPoints').count()

        request.onsuccess = () => resolve(request.result)
      })
    }

    await waitFor(() => pdk.database !== null && pdk.uploadUrl !== '', 10000, 'database open and configuration loaded')

    const stamp = new self.rexDateString(epochSeconds)

    // Fails loudly if DateString stops being the thing this test assumes: a
    // value the structured clone algorithm cannot carry.
    if (Object.keys(stamp.value).length !== 0) {
      throw new Error('Test setup invalid: DateString.value now has own enumerable properties, so structured clone would preserve it and this test could no longer fail.')
    }

    const before = await countPoints()

    // Goes in the way a real producer does: rex-core's dispatchEvent fans the
    // event out to every registered module, so this covers logEvent and the
    // content-processing pass rather than starting at enqueueDataPoint. The
    // spider reaches PDK by exactly this route, with these field names.
    self.rexDispatchEvent({
      name: generatorId,
      date: dateMs,
      started: stamp,
      ended: stamp
    })

    const started = Date.now()

    while ((await countPoints()) <= before) {
      if (Date.now() - started > 8000) {
        throw new Error('Timed out waiting for the point to persist to IndexedDB.')
      }

      await new Promise((resolve) => self.setTimeout(resolve, 25))
    }

    return stamp.toJSON()
  }, { generatorId, epochSeconds: CONVERSATION_EPOCH_SECONDS, dateMs: POINT_DATE_MS })
}

// No content processor is registered in this harness, so the DateString reaches
// serialization with its prototype intact and its own toJSON flattens it to an
// ISO string. A consumer that registers one (Keystone registers openredaction)
// gets `{ value: <iso>, originalValue: '' }` instead, because the processing
// walker rebuilds objects as plain ones and drops the prototype. Either way the
// instant survives, and either way the defect replaced it with `{}`.
test('a DateString on a dispatched point survives the persist to IndexedDB', async ({serviceWorker}) => {
  const expectedIso = await dispatchConversationPoint(serviceWorker, 'datestring-persist-test')

  const persisted = await serviceWorker.evaluate(async (generatorId) => {
    return new Promise((resolve) => {
      const request = self.rexPDKPlugin.database.transaction(['dataPoints'], 'readonly').objectStore('dataPoints').getAll()

      request.onsuccess = () => {
        const record = request.result.find((candidate) => candidate.generatorId === generatorId)

        resolve(record === undefined ? null : record.dataPoint)
      }
    })
  }, 'datestring-persist-test')

  expect(persisted).not.toBeNull()
  expect(persisted['started']).toEqual(expectedIso)
  expect(persisted['ended']).toEqual(expectedIso)
})

test('the DateString the server receives is the instant, not an empty object', async ({serviceWorker, request}) => {
  const expectedIso = await dispatchConversationPoint(serviceWorker, 'datestring-server-test')

  await serviceWorker.evaluate(() => self.rexPDKPlugin.uploadQueuedDataPoints(() => {}))

  // Asking the server what it stored closes the loop the in-worker assertions
  // leave open: a point can look correct on its way out and still land empty.
  const response = await request.get(`/data/points.json?timestamp=${POINT_TIMESTAMP}`)

  expect(response.ok()).toBeTruthy()

  const body = await response.json()

  const received = body.points.find((point) => point['passive-data-metadata']['generator-id'] === 'datestring-server-test')

  expect(received).toBeDefined()
  expect(received['started']).toEqual(expectedIso)
  expect(received['ended']).toEqual(expectedIso)
})
