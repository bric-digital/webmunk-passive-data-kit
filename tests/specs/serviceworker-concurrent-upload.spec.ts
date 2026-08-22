import { test, expect } from './fixtures';

// Two upload triggers can overlap (e.g. a config-apply notification firing
// refreshConfiguration while a scheduled upload is in flight). Overlapping
// uploads read the same untransmitted points and ship them twice, so the
// upload path must be serialized: a point enqueued once reaches the server
// exactly once no matter how many triggers fire.

function countPointsByGenerator(results, generatorId) {
  let count = 0
  for (const result of results) {
    if (!Array.isArray(result)) continue
    for (const response of result) {
      if (response === null || typeof response !== 'object' || !Array.isArray(response.payload)) continue
      for (const dataPoint of response.payload) {
        if (dataPoint.generatorId === generatorId) count++
      }
    }
  }
  return count
}

test('concurrent upload calls transmit each point exactly once', async ({serviceWorker}) => {
  serviceWorker.evaluate((resolve) => {
    self.rexCorePlugin.handleMessage({
        'messageType': 'waitForConfiguration',
        'event': {
          'timeout': 10000
        }
    }).then((configuration) => {
      console.log(`[concurrent] configuration: ${configuration}`)

      self.rexCorePlugin.handleMessage({
        'messageType': 'logEvent',
        'event': {
          'name': 'rex-pdk-concurrent-test'
        }
      }, self, () => {
        self.setTimeout(() => {
          Promise.allSettled([
            self.rexPDKPlugin.uploadQueuedDataPoints(() => {}, [], 1000),
            self.rexPDKPlugin.uploadQueuedDataPoints(() => {}),
          ]).catch((results) => {
            resolve(results)
          })
        }, 1500)
      })
    }).catch((err) => {
      resolve(`[concurrent] Error waiting for configuration: ${err}`)
    })
  }).then((results) => {
    console.log(`[concurrent] results: ${results}`)

    const settled = results.map((result) => (result.status === 'fulfilled' ? result.value : `rejected: ${result.reason}`))

    expect(countPointsByGenerator(settled, 'rex-pdk-concurrent-test')).toEqual(1)
  })
})
