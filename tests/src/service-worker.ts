import { REXConfiguration } from '@bric/rex-core/common'
import corePlugin, { dispatchEvent } from '@bric/rex-core/service-worker'
import { DateString } from '@bric/rex-types/types'
import pdkPlugin, { PassiveDataKitPointAnnotator, REXPDKDataPoint } from '@bric/rex-passive-data-kit/service-worker'

console.log(`Imported ${corePlugin} into service worker context...`)
console.log(`Imported ${pdkPlugin} into service worker context...`)

self['rexCorePlugin'] = corePlugin
self['rexPDKPlugin'] = pdkPlugin

// rex-core exports dispatchEvent at module scope rather than on the plugin, so
// the harness has to put it on `self` for a spec to reach it. Assigning the
// bare name shadows EventTarget's dispatchEvent, which the worker scope also
// has and which nothing here uses.
self['dispatchEvent'] = dispatchEvent

// The real DateString, so the persistence tests exercise the actual type that
// lost its value rather than a local imitation of it. A stand-in can only
// encode what we already believe about DateString; if the type changes, the
// stand-in keeps passing while collection breaks.
self['DateString'] = DateString

class TestDataPointAnnotator extends PassiveDataKitPointAnnotator {
  annotate(dataPoint: REXPDKDataPoint): Promise<void> {
    return new Promise<void>((resolve) => {
      corePlugin.fetchConfiguration()
        .then((configuration: REXConfiguration) => {
          const testFields = {
            'test-field': configuration['testing']['test-field']
          }

          dataPoint['testing'] = testFields

          resolve()
        })
    })
  }

  toString():string {
    return 'TestDataPointAnnotator'
  }
}

pdkPlugin.registerDataPointAnnotator(new TestDataPointAnnotator())

class FooDataPointAnnotator extends PassiveDataKitPointAnnotator {
  annotate(dataPoint: REXPDKDataPoint): Promise<void> {
    return new Promise<void>((resolve) => {
      dataPoint['annotate-foo'] = 'bar'

      resolve()
    })
  }

  toString():string {
    return 'FooDataPointAnnotator'
  }
}

pdkPlugin.registerDataPointAnnotator(new FooDataPointAnnotator())

corePlugin.setup()
