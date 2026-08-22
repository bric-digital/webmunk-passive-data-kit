import { test, expect } from './fixtures';

// Both tests pin the same defect: a point enqueued less than a second after the
// last persist sits in the in-memory queuedPoints array with nothing scheduled
// to write it to IndexedDB, so an MV3 worker suspension loses it and an
// on-demand drain cannot see it. Setup for each: enqueue point A and wait for
// its persist, then enqueue point B inside the one-second throttle window so B
// strands in memory.

const strandSecondPoint = (serviceWorker) => {
  return serviceWorker.evaluate(async () => {
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

    const waitForCount = async (expected: number, timeoutMs: number, label: string) => {
      const started = Date.now()

      while ((await countPoints()) < expected) {
        if (Date.now() - started > timeoutMs) {
          throw new Error(`Timed out waiting for: ${label}`)
        }

        await new Promise((resolve) => self.setTimeout(resolve, 25))
      }
    }

    await waitFor(() => pdk.database !== null && pdk.uploadUrl !== '', 10000, 'database open and configuration loaded')

    pdk.enqueueDataPoint('strand-test-a', { 'test': 'a' })

    await waitForCount(1, 5000, 'point A persisted to IndexedDB')

    pdk.enqueueDataPoint('strand-test-b', { 'test': 'b' })

    await waitFor(() => pdk.queuedPoints.length === 1, 5000, 'point B enqueued in memory')

    // A persist triggered at enqueue time would drain within milliseconds; if B
    // is still queued after half a second, it stranded inside the throttle window.
    await new Promise((resolve) => self.setTimeout(resolve, 500))

    if (pdk.queuedPoints.length !== 1) {
      throw new Error('Test setup raced: point B persisted instead of stranding in the throttle window.')
    }
  })
}

test('a point enqueued inside the persist throttle window still reaches IndexedDB', async ({serviceWorker}) => {
  await strandSecondPoint(serviceWorker)

  const persistedCount = await serviceWorker.evaluate(async () => {
    // No further enqueues arrive: the module must persist the stranded point on
    // its own before the worker can be suspended. Give it ample time, then
    // count what is durable.
    await new Promise((resolve) => self.setTimeout(resolve, 3000))

    return new Promise<number>((resolve) => {
      const request = self.rexPDKPlugin.database.transaction(['dataPoints'], 'readonly').objectStore('dataPoints').count()

      request.onsuccess = () => resolve(request.result)
    })
  })

  expect(persistedCount).toEqual(2)
})

test('an on-demand drain uploads points still held in the in-memory queue', async ({serviceWorker}) => {
  await strandSecondPoint(serviceWorker)

  const uploadedGenerators = await serviceWorker.evaluate(async () => {
    const responses = await self.rexPDKPlugin.uploadQueuedDataPoints(() => {})

    const generators: string[] = []

    for (const response of responses) {
      for (const point of response.payload) {
        generators.push(point['passive-data-metadata']['generator-id'])
      }
    }

    return generators
  })

  expect(uploadedGenerators).toContain('strand-test-a')
  expect(uploadedGenerators).toContain('strand-test-b')
})
