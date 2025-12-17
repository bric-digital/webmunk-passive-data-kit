import { WebmunkConfiguration } from '@bric/webmunk-core/extension'

import { WebmunkClientModule, registerWebmunkModule } from '@bric/webmunk-core/browser'

class PassiveDataKitModule extends WebmunkClientModule {
  configuration: any
  refreshTimeout: number = 0

  constructor() {
    super()
  }

  setup() {
    console.log(`Setting up PassiveDataKitModule...`)

    chrome.runtime.sendMessage({
        'messageType': 'fetchConfiguration',
      }).then((response:{ [name: string]: any; }) => { // eslint-disable-line @typescript-eslint/no-explicit-any
        const configuration = response as WebmunkConfiguration

        this.configuration = configuration['page_manipulation']
      })
  }

  applyConfiguration() {
    console.log('PassiveDataKitModule.applyConfiguration')

    if ([null, undefined].includes(this.configuration)) {
      return
    }

    for (const elementRule of this.configuration['passive_data_kit']) {
    }
  }
}

const plugin = new PassiveDataKitModule()

registerWebmunkModule(plugin)

export default plugin
