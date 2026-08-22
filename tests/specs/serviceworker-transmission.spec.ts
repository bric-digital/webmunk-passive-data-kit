import { test, expect } from './fixtures';

test('Service worker transmission tests', async ({serviceWorker}) => {
  return new Promise<void>((resolve) => {
    setTimeout(() => {
      serviceWorker.evaluate(async () => {
        return new Promise((testResolve) => {
          const doTest = () => {
            self.rexCorePlugin.handleMessage({
              'messageType': 'logEvent',
              'event': {
                'name': 'rex-pdk-test'
              }
            }, this, (loggedCount) => {
              self.setTimeout(() => {
                self.rexPDKPlugin.uploadQueuedDataPoints((remaining: number) => {},).then((uploadResponse) => {
                  testResolve(uploadResponse)
                }, (error) => {
                  testResolve(`uploadQueuedDataPoints error: ${error}`)
                }).catch((error) => {
                  testResolve(`uploadQueuedDataPoints catch: ${error}`)
                })
              }, 1000)
            })
          }

          self.setTimeout(() => {
            try {
              self.rexCorePlugin.handleMessage({
                'messageType': 'waitForConfiguration',
                'event': {
                  'timeout': 5000
                },
              }, this, (configuration) => {
                doTest()
              })
            } catch (err) {
              testResolve(`waitForConfiguration error: ${err}`)
            }
          }, 2000)
        })
      })
      .then((workerResponse) => {
        // console.log(`[transmission] workerResponse: "${workerResponse}" -- ${typeof workerResponse} -- ${JSON.stringify(workerResponse)}`)

        if ((typeof workerResponse) == 'string') {
          expect(workerResponse).toEqual(0)
        } else {
          expect(typeof workerResponse).not.toBe('string');
          expect(workerResponse[0].payload.length).toEqual(2)

          expect(workerResponse[0].payload[0]['annotate-foo']).toEqual('bar')
          expect(workerResponse[0].payload[1]['testing']).toEqual({'test-field': 'hello world'})
        }

        resolve()
      })
    }, 1000)
  })
})
