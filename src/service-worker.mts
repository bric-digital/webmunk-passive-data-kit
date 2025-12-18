
import * as nacl from "tweetnacl";
import * as naclUtil from "tweetnacl-util";

import { WebmunkConfiguration } from '@bric/webmunk-core/extension'
import webmunkCorePlugin, { WebmunkServiceWorkerModule, registerWebmunkModule } from '@bric/webmunk-core/service-worker'
import { error } from "jquery";

const PDK_DATABASE_VERSION = 1

class PassiveDataKitModule extends WebmunkServiceWorkerModule {
  uploadUrl:string = ''
  serverKey:string = ''
  serverFieldKey:Uint8Array<ArrayBufferLike>
  localFieldKey:Uint8Array<ArrayBufferLike>

  identifier:string = 'unknown-id'

  alarmCreated:boolean = false

  database = null
  queuedPoints = []
  lastPersisted = 0

  currentlyUploading:boolean = false

  constructor() {
    super()
  }

  moduleName() {
    return 'PassiveDataKitModule'
  }

  setup() {
    const request = indexedDB.open('passive_data_kit', PDK_DATABASE_VERSION)

    request.onerror = (event) => {
      console.error(`[PassiveDataKitModule] Unable to open Passive Data Kit database: ${event}`)
    }

    request.onsuccess = (event) => {
      this.database = request.result

      console.log(`[PassiveDataKitModule] Successfully opened Passive Data Kit database.`)
    }

    request.onupgradeneeded = (event) => {
      console.log('request.onupgradeneeded')
      console.log(event)

      this.database = request.result

      switch (event.oldVersion) {
        case 0: {
          const dataPoints = this.database.createObjectStore('dataPoints', {
            keyPath: 'dataPointId',
            autoIncrement: true
          })

          dataPoints.createIndex('generatorId', 'generatorId', { unique: false })
          dataPoints.createIndex('dataPoint', 'dataPoint', { unique: false })
          dataPoints.createIndex('date', 'date', { unique: false })
          dataPoints.createIndex('transmitted', 'transmitted', { unique: false })

          console.log(`[PassiveDataKitModule] Successfully upgraded Passive Data Kit database.`)
        }
      }
    }

    this.refreshConfiguration()
  }

  updateConfiguration(config) {
    console.log('[PDK] updateConfiguration')
    console.log(config)

    this.uploadUrl = config['endpoint']
    this.identifier = config['identifier']

    let fieldKey = config['field_key']

    if (['', undefined, null].includes(fieldKey) === false) {
      const keyPair = nacl.box.keyPair()

      this.serverFieldKey = naclUtil.decodeBase64(fieldKey)
      this.localFieldKey = keyPair.secretKey
    }
  }

  blobToB64(data) {
    return btoa(new Uint8Array(data).reduce((data, byte) =>
      data + String.fromCharCode(byte),
      ''))
  }

  refreshConfiguration() {
    console.log('PassiveDataKitModule refreshing configuration...')

    const me = this

    webmunkCorePlugin.fetchConfiguration()
      .then((configuration:WebmunkConfiguration) => {
        console.log('PassiveDataKitModule fetched:')
        console.log(configuration)

        if (configuration !== undefined) {
          const passiveDataKitConfig = configuration['passive_data_kit']

          if (passiveDataKitConfig !== undefined) {
            this.updateConfiguration(passiveDataKitConfig)

            if (me.alarmCreated === false) {
              chrome.alarms.create('pdk-upload', { periodInMinutes: 0.5 })

              chrome.alarms.onAlarm.addListener((alarm) => {
                console.log(`[PDK] ALARM...`)
                console.log(alarm)

                if (alarm.name === 'pdk-upload') {
                  console.log(`[PDK] Uploading data points...`)

                  me.uploadQueuedDataPoints((remaining) => {
                    console.log(`[PDK] ${remaining} data points to upload...`)
                  })
                  .then(() => {
                    console.log(`[PDK] Upload complete...`)

                    me.refreshConfiguration()
                  })
                }
              })

              me.alarmCreated = true
            }
            return
          }
        }

        setTimeout(() => {
          this.refreshConfiguration()
        }, 1000)
      })
  }

  logEvent(event:any) {
    if (event !== undefined) {
      if (['', null, undefined].includes(event.name) == false) {
        console.log('[PDK] Enqueue data point for logging:')
        console.log(event)

        this.enqueueDataPoint(event.name, event)
      }
    }
  }

  async enqueueDataPoint(generatorId, dataPoint) {
    return new Promise<void>((resolve) => {
      if (generatorId === null || dataPoint === null) {
        // pass
      } else {
        const payload = {
          generatorId,
          dataPoint,
          transmitted: 0
        }

        if (dataPoint.date !== undefined) {
          payload['date'] = dataPoint.date
        } else {
          payload['date'] = Date.now()
        }

        this.queuedPoints.push(payload)
      }

      if (this.queuedPoints.length > 0 && (Date.now() - this.lastPersisted) > 1000) {
        this.persistDataPoints()
          .then(() => {
            resolve()
          })
      } else {
        resolve()
      }
    })
  }

  async persistDataPoints () {
    return new Promise<void>((resolve) => {
      this.lastPersisted = Date.now()

      const pendingPoints = this.queuedPoints

      this.queuedPoints = []

      const objectStore = this.database.transaction(['dataPoints'], 'readwrite').objectStore('dataPoints')

      pendingPoints.forEach(function (point) {
        const request = objectStore.add(point)

        request.onsuccess = function (event) {
          console.log(`[PassiveDataKitModule] Data point saved successfully: ${point.generatorId}.`)
        }

        request.onerror = function (event) {
          console.log(`[PassiveDataKitModule] Data point enqueuing failed: ${point.generatorId}.`)
          console.log(event)
        }
      })

      console.log(`[PassiveDataKitModule] Data points saved successfully: ${pendingPoints.length}.`)

      resolve()
    })
  }

  async uploadBundle(points) {
    const me = this

    return new Promise<void>((resolve) => {
      const manifest = chrome.runtime.getManifest()

      const keyPair = nacl.box.keyPair()

      const serverPublicKey = naclUtil.decodeBase64(this.serverKey)

      const userAgent = manifest.name + '/' + manifest.version + ' ' + navigator.userAgent

      for (let i = 0; i < points.length; i++) {
        const metadata = {}

        if (points[i].date === undefined) {
          points[i].date = (new Date()).getTime()
        }

        console.log(`metadata['source'] = ${me.identifier}`)

        metadata['source'] = me.identifier
        metadata['generator'] = points[i].generatorId + ': ' + userAgent
        metadata['generator-id'] = points[i].generatorId
        metadata['timestamp'] = points[i].date / 1000 // Unix timestamp
        // metadata['generated-key'] = nacl.util.encodeBase64(keyPair.publicKey)
        metadata['timezone'] = Intl.DateTimeFormat().resolvedOptions().timeZone

        points[i]['passive-data-metadata'] = metadata

        // pdk.encryptFields(serverPublicKey, keyPair.secretKey, points[i])
      }

      const dataString = JSON.stringify(points, null, 2)

      const byteArray = new TextEncoder().encode(dataString)
      const cs = new CompressionStream('gzip')
      const writer = cs.writable.getWriter()
      writer.write(byteArray)
      writer.close()

      const compressedResponse = new Response(cs.readable)

      compressedResponse.arrayBuffer()
        .then(function (buffer) {
          const compressedBase64 = me.blobToB64(buffer)

          console.log(`[PDK] upload to "${me.uploadUrl}"...`)

          fetch(me.uploadUrl, {
            method: 'POST',
            mode: 'cors', // no-cors, *cors, same-origin
            cache: 'no-cache', // *default, no-cache, reload, force-cache, only-if-cached
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded'
            },
            redirect: 'follow', // manual, *follow, error
            referrerPolicy: 'no-referrer', // no-referrer, *no-referrer-when-downgrade, origin, origin-when-cross-origin, same-origin, strict-origin, strict-origin-when-cross-origin, unsafe-url
            body: new URLSearchParams({
              compression: 'gzip',
              payload: compressedBase64
            })
          }) // body data type must match "Content-Type" header
            .then(response => response.json())
            .then(function (data) {
              resolve()
            })
            .catch((error) => {
              console.error('Error:', error)
            })
        })
    })
  }

  async updateDataPoints(dataPoints) {
    const me = this

    return new Promise<void>((resolve, reject) => {
      if (dataPoints.length === 0) {
        resolve()
      } else {
        const dataPoint = dataPoints.pop()

        const request = this.database.transaction(['dataPoints'], 'readwrite')
          .objectStore('dataPoints')
          .put(dataPoint)

        request.onsuccess = function (event) {
          me.updateDataPoints(dataPoints)
        }

        request.onerror = function (event) {
          console.log('The data has write has failed')
          console.log(event)

          reject(error)
        }
      }
    })
  }

  async uploadQueuedDataPoints (progressCallback) {
    const me = this

    return new Promise<void>((resolve, reject) => {
      if (this.currentlyUploading) {
        resolve()
      }

      const index = this.database.transaction(['dataPoints'], 'readonly')
        .objectStore('dataPoints')
        .index('transmitted')

      const countRequest = index.count(0)

      countRequest.onsuccess = () => {
        console.log(`[PDK] Remaining data points: ${countRequest.result}`)

        const request = index.getAll(0, 64)

        request.onsuccess = function () {
          const pendingItems = request.result

          if (pendingItems.length === 0) {
            this.currentlyUploading = false

            resolve()
          } else {
            const toTransmit = []
            const xmitBundle = []

            const pendingRemaining = pendingItems.length

            console.log(`[PDK] Remaining data points (this bundle): ${pendingRemaining}`)

            progressCallback(pendingRemaining)

            let bundleLength = 0

            for (let i = 0; i < pendingRemaining && bundleLength < (128 * 1024); i++) {
              const pendingItem = pendingItems[i]

              pendingItem.transmitted = new Date().getTime()

              pendingItem.dataPoint.date = pendingItem.date
              pendingItem.dataPoint.generatorId = pendingItem.generatorId

              toTransmit.push(pendingItem)
              xmitBundle.push(pendingItem.dataPoint)

              const bundleString = JSON.stringify(pendingItem.dataPoint)

              bundleLength += bundleString.length
            }

            const status = {
              pending_points: pendingRemaining,
              generatorId: 'pdk-system-status'
            }

            chrome.system.cpu.getInfo()
              .then((cpuInfo) => {
                status['cpu-info'] = cpuInfo

                return chrome.system.display.getInfo()
              })
              .then((displayUnitInfo) => {
                status['display-info'] = displayUnitInfo

                return chrome.system.memory.getInfo()
              })
              .then((memoryInfo) => {
                status['memory-info'] = memoryInfo

                return chrome.system.storage.getInfo()
              })
              .then((storageUnitInfo) => {
                status['storage-info'] = storageUnitInfo

                xmitBundle.push(status)

                if (toTransmit.length === 0) {
                  me.currentlyUploading = false

                  resolve()
                } else {
                  me.uploadBundle(xmitBundle)
                    .then(() => {
                      return me.updateDataPoints(toTransmit)
                    })
                    .then(() => {
                      me.currentlyUploading = false

                      return me.uploadQueuedDataPoints(progressCallback)
                    })
                }
              })
          }
        }

        request.onerror = (event) => {
          console.log('[PDK] PDK database error')
          console.log(event)
          reject(event)
        }
      }

      countRequest.onerror = (event) => {
        console.log('[PDK] PDK database error')
        console.log(event)
        reject(event)
      }
    })
  }

  encryptFields(payload) {
    if ([this.serverFieldKey, this.localFieldKey].includes(undefined)) {
      return
    }

    for (const itemKey in payload) {
      const value = payload[itemKey]

      const toRemove = []

      if (itemKey.endsWith('*')) {
        const originalValue = '' + value

        payload[itemKey.replace('*', '!')] = originalValue

        const nonce = nacl.randomBytes(nacl.secretbox.nonceLength)
        const messageUint8 = naclUtil.decodeUTF8(JSON.stringify(value))

        const cipherBox = nacl.box(messageUint8, nonce, this.serverFieldKey, this.localFieldKey)

        const fullMessage = new Uint8Array(nonce.length + cipherBox.length)

        fullMessage.set(nonce)
        fullMessage.set(cipherBox, nonce.length)

        const base64FullMessage = naclUtil.encodeBase64(fullMessage)

        payload[itemKey] = base64FullMessage

        toRemove.push(itemKey)
      } else if (value != null && value.constructor.name === 'Object') {
        this.encryptFields(value)
      } else if (value != null && Array.isArray(value)) {
        value.forEach(function (valueItem) {
          if (valueItem.constructor.name === 'Object') {
            this.encryptFields(valueItem)
          }
        })
      }
    }
  }
}

const plugin = new PassiveDataKitModule()

registerWebmunkModule(plugin)

export default plugin
