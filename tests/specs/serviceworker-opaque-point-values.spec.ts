import { test, expect } from './fixtures';

// These tests pin the defect fixed in 6341080: persisting a point with
// `objectStore.add(point)` handed the raw object to the structured clone
// algorithm, which copies only own enumerable properties. A value that keeps
// its state in private slots and exposes it through `toJSON` on the prototype
// therefore cloned to `{}` — without raising DataCloneError. The point was
// saved and uploaded looking well-formed, with the value silently gone.
//
// This is how every rex-types `DateString` lost its timestamp: it wraps a
// `Temporal.Instant` from @js-temporal/polyfill, which has no own enumerable
// properties. rex-spider-chatgpt writes three of them per conversation
// (`started`, `ended`, and `when` on every turn), so conversation timing was
// blank in the collected data while the conversations themselves arrived fine.
//
// `opaqueStamp` below reproduces that shape without pulling in the polyfill:
// no own enumerable properties, value reachable only via prototype `toJSON`.
// Guard when editing: if it ever gains an own enumerable property, structured
// clone starts preserving it and these tests pass against the defect.

const ISO_STAMP = '2026-04-30T17:30:08.089696768Z'

// Pins `passive-data-metadata.timestamp` so the server-side test can retrieve
// exactly this point. stampPointMetadata derives that field as `date / 1000`.
const POINT_DATE_MS = 1777570208089
const POINT_TIMESTAMP = POINT_DATE_MS / 1000

const enqueueOpaquePoint = (serviceWorker, generatorId: string) => {
  return serviceWorker.evaluate(async ({ generatorId, iso, dateMs }) => {
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

    // Stands in for Temporal.Instant: structured clone sees nothing to copy,
    // JSON serialization reaches the value through the prototype. Nested under
    // `value` to match a DateString, which holds its instant that way.
    const opaqueStamp = Object.create({ toJSON: () => iso })

    if (Object.keys(opaqueStamp).length !== 0) {
      throw new Error('Test setup invalid: opaqueStamp must have no own enumerable properties.')
    }

    const before = await countPoints()

    // Goes in the way a real producer does: rex-core's dispatchEvent fans the
    // event out to every registered module, so this covers logEvent and the
    // content-processing pass rather than starting at enqueueDataPoint. The
    // spider reaches PDK by exactly this route.
    self.rexDispatchEvent({
      name: generatorId,
      date: dateMs,
      ended: {
        value: opaqueStamp,
        originalValue: ''
      }
    })

    const started = Date.now()

    while ((await countPoints()) <= before) {
      if (Date.now() - started > 8000) {
        throw new Error('Timed out waiting for the point to persist to IndexedDB.')
      }

      await new Promise((resolve) => self.setTimeout(resolve, 25))
    }
  }, { generatorId, iso: ISO_STAMP, dateMs: POINT_DATE_MS })
}

test('a point value reachable only through toJSON survives the persist to IndexedDB', async ({serviceWorker}) => {
  await enqueueOpaquePoint(serviceWorker, 'opaque-persist-test')

  const persisted = await serviceWorker.evaluate(async (generatorId) => {
    return new Promise((resolve) => {
      const request = self.rexPDKPlugin.database.transaction(['dataPoints'], 'readonly').objectStore('dataPoints').getAll()

      request.onsuccess = () => {
        const record = request.result.find((candidate) => candidate.generatorId === generatorId)

        resolve(record === undefined ? null : record.dataPoint)
      }
    })
  }, 'opaque-persist-test')

  expect(persisted).not.toBeNull()

  // The defect wrote `{}` here rather than failing, so asserting on the value
  // is the only thing that catches it.
  expect(persisted['ended']['value']).toEqual(ISO_STAMP)
  expect(persisted['ended']['originalValue']).toEqual('')
})

test('the value the server receives is the timestamp, not an empty object', async ({serviceWorker, request}) => {
  await enqueueOpaquePoint(serviceWorker, 'opaque-server-test')

  await serviceWorker.evaluate(() => self.rexPDKPlugin.uploadQueuedDataPoints(() => {}))

  // Asking the server what it stored closes the loop the in-worker assertions
  // leave open: a point can look correct on its way out and still land empty.
  const response = await request.get(`/data/points.json?timestamp=${POINT_TIMESTAMP}`)

  expect(response.ok()).toBeTruthy()

  const body = await response.json()

  const received = body.points.find((point) => point['passive-data-metadata']['generator-id'] === 'opaque-server-test')

  expect(received).toBeDefined()
  expect(received['ended']['value']).toEqual(ISO_STAMP)
  expect(received['ended']['originalValue']).toEqual('')
})
