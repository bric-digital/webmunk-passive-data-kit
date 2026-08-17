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
  const settled = await serviceWorker.evaluate(async () => {
    await new Promise((readyDelay) => self.setTimeout(readyDelay, 1000))

    await new Promise((logged) => {
      self.rexCorePlugin.handleMessage({
        'messageType': 'logEvent',
        'event': {
          'name': 'rex-pdk-concurrent-test'
        }
      }, self, logged)
    })

    await new Promise((settleDelay) => self.setTimeout(settleDelay, 1500))

    const results = await Promise.allSettled([
      self.rexPDKPlugin.uploadQueuedDataPoints(() => {}),
      self.rexPDKPlugin.uploadQueuedDataPoints(() => {}),
    ])

    return results.map((result) => (result.status === 'fulfilled' ? result.value : `rejected: ${result.reason}`))
  })

  expect(countPointsByGenerator(settled, 'rex-pdk-concurrent-test')).toEqual(1)
})
