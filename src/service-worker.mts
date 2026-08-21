
import * as nacl from 'tweetnacl'
import * as naclUtil from 'tweetnacl-util'

import stringify from 'json-stable-stringify'

import { REXConfiguration } from '@bric/rex-core/common'
import { REXContentProcessorManager } from '@bric/rex-content-processing/library'
import rexCorePlugin, { REXServiceWorkerModule, registerREXModule } from '@bric/rex-core/service-worker'

const PDK_DATABASE_VERSION = 1

export interface REXPDKPointMetadata {
  source: string,
  generator: string,
  'generator-id': string,
  timestamp: number,
  timezone: string,
  'configuration-hash'?: string,
  'enqueued-at'?: number,
}

export interface REXPDKDataPoint {
  date?: number,
  [key: string]: any, // eslint-disable-line @typescript-eslint/no-explicit-any
  'passive-data-metadata'?: REXPDKPointMetadata
  configurationHash?: string,
  enqueuedAt?: number,
}

export interface REXPDKDataPointDBRecord {
  generatorId: string,
  dataPoint: REXPDKDataPoint,
  transmitted: number,
  date?: number,
}

export interface REXPDKStatusDataPoint {
  'pending-points': number,
  'generatorId': 'pdk-system-status',
  'cpu-info'?: chrome.system.cpu.CpuInfo,
  'display-info'?: chrome.system.display.DisplayUnitInfo[],
  'memory-info'?: chrome.system.memory.MemoryInfo,
  'storage-info'?: chrome.system.storage.StorageUnitInfo[],
  'local-storage-bytes'?: number,
  configurationHash?: string,
}

export interface REXPDKConfiguration {
  endpoint: string,
  identifier: string,
  field_key?: string,
  // 'v3' uploads bundles with PUT and a bearer credential. Any other value (or
  // none) uses the legacy form-encoded POST. There is deliberately no fallback
  // between the two: a server that only accepts v3 can only reject a POST, so
  // failing loudly and leaving the bundle queued beats silently downgrading.
  endpoint_version?: string,
  authorization?: REXPDKAuthorization,
}

export interface REXPDKAuthorization {
  token?: string,
}

export class REXPDKUploadError extends Error {
  status: number
  responseBody: unknown

  constructor(status: number, responseBody: unknown) {
    super(`Data bundle upload failed with HTTP ${status}.`)

    this.name = 'REXPDKUploadError'
    this.status = status
    this.responseBody = responseBody
  }
}

export interface REXPDKEvent {
  name: string;
  [key: string]: any; // eslint-disable-line @typescript-eslint/no-explicit-any
}

export class PassiveDataKitPointAnnotator {
  annotate(dataPoint:REXPDKDataPoint):Promise<void> { // eslint-disable-line @typescript-eslint/no-unused-vars
    return new Promise<void>((resolve) => {
      // Intentionally does nothing - subclass 

      resolve()
    })
  }

  toString():string {
    return 'PassiveDataKitPointAnnotator'
  }
}

class PassiveDataKitModule extends REXServiceWorkerModule {
  uploadUrl: string = ''
  endpointVersion: string = ''
  bearerToken: string = ''
  serverKey: string = ''
  serverFieldKey: Uint8Array<ArrayBufferLike> | null = null
  localFieldKey: Uint8Array<ArrayBufferLike> | null = null

  dataPointAnnotators:PassiveDataKitPointAnnotator[] = []

  identifier: string = 'unknown-id'

  alarmCreated: boolean = true

  database: IDBDatabase | null = null
  queuedPoints: REXPDKDataPointDBRecord[] = []
  lastPersisted = 0
  persistTimer: ReturnType<typeof setTimeout> | null = null

  currentlyUploading: boolean = false

  moduleName() {
    return 'PassiveDataKitModule'
  }

  setup() {
    const request = indexedDB.open('passive_data_kit', PDK_DATABASE_VERSION)

    request.onerror = (event) => {
      console.error(`[rex-passive-data-kit] Unable to open Passive Data Kit database: ${event}`)
    }

    request.onsuccess = (event) => { // eslint-disable-line @typescript-eslint/no-unused-vars
      this.database = request.result

      console.log(`[rex-passive-data-kit] Successfully opened Passive Data Kit database.`)
    }

    request.onupgradeneeded = (event) => {
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

          console.log(`[rex-passive-data-kit] Successfully upgraded Passive Data Kit database.`)
        }
      }
    }

    this.refreshConfiguration()
  }

  registerDataPointAnnotator(annotator:PassiveDataKitPointAnnotator):void {
    this.dataPointAnnotators.push(annotator)
  }

  updateConfiguration(config: REXPDKConfiguration) {
    this.uploadUrl = config['endpoint']

    // Validated at upload time, not here: a refresh that threw on a malformed
    // credential would wedge the module on a stale endpoint.
    this.endpointVersion = config['endpoint_version'] || ''
    this.bearerToken = config['authorization']?.token || ''

    if (config['identifier'] !== undefined && config['identifier'] !== null) {
      this.identifier = config['identifier']
    } else {
      console.warn('[rex-passive-data-kit] Attempting to use configuration with null or undefined identifier:')
      console.warn(config)
    }

    if (this.identifier.toLowerCase() === 'undefined') {
      console.warn('[rex-passive-data-kit] Identifier matching the string "undefined" provided in configuration:')
      console.warn(config)
    }

    const fieldKey = config['field_key']

    if (fieldKey !== undefined) {
      if (['', undefined, null].includes(fieldKey) === false) {
        const keyPair = nacl.box.keyPair()

        this.serverFieldKey = naclUtil.decodeBase64(fieldKey)
        this.localFieldKey = keyPair.secretKey
      }
    }
  }

  blobToB64(iterableData: any) { // eslint-disable-line @typescript-eslint/no-explicit-any
    return btoa(new Uint8Array(iterableData).reduce((data, byte) => data + String.fromCharCode(byte), ''))
  }

  refreshConfiguration() {
    rexCorePlugin.fetchConfiguration()
      .then((configuration: REXConfiguration) => {
        if (configuration !== undefined) {
          const passiveDataKitConfig: REXPDKConfiguration = (configuration as any)['passive_data_kit'] // eslint-disable-line @typescript-eslint/no-explicit-any

          if (passiveDataKitConfig !== undefined) {
            this.updateConfiguration(passiveDataKitConfig)

            this.uploadQueuedDataPoints((remaining: number) => {
              console.log(`[rex-passive-data-kit] ${remaining} data points to upload...`)
            })
            .then((response) => { // eslint-disable-line @typescript-eslint/no-unused-vars
              console.log(`[rex-passive-data-kit] Upload complete.`)
            }, (error) => {
              console.log(`[rex-passive-data-kit] Upload error[0]: ${error}`)
            })
            .catch((error) => {
              console.log(`[rex-passive-data-kit] Upload error[1]: ${error}`)
            })

            return
          }
        }

        setTimeout(() => {
          this.refreshConfiguration()
        }, 1000)
      })
  }

  logEvent(event: REXPDKEvent) {
    if (event !== undefined) {
      if (['', null, undefined].includes(event['name']) == false) {
        console.log('[rex-passive-data-kit] Enqueue data point for logging:')
        console.log(event)

        REXContentProcessorManager.getInstance().processContent(event)
          .then((processed) => {
            this.enqueueDataPoint(event['name'], processed)
          })
      }
    }
  }

  enqueueDataPoint(generatorId: string, dataPoint: REXPDKDataPoint) {
    rexCorePlugin.fetchConfiguration()
      .then((configuration: REXConfiguration) => {
          this.normalizeConfiguration(configuration)

          if (generatorId === null || dataPoint === null) {
            // pass
          } else {
            const payload:REXPDKDataPointDBRecord = {
              generatorId,
              dataPoint,
              transmitted: 0
            }

            if (dataPoint.date !== undefined) {
              let dateObj = (dataPoint.date as any) // eslint-disable-line @typescript-eslint/no-explicit-any

              if (dateObj instanceof Date) {
                dateObj = dateObj.getTime()
              }
              
              payload.date = dateObj
            } else {
              payload.date = Date.now()
            }

            const persistPoint = (payload:REXPDKDataPointDBRecord) => {
              this.annotateDataPoint(payload.dataPoint)
                .then(() => {
                  this.queuedPoints.push(payload)

                  if (this.queuedPoints.length > 0 && (Date.now() - this.lastPersisted) > 1000) {
                    this.persistDataPoints()
                      .then((pointsSaved: number) => {
                        console.log(`[rex-passive-data-kit] ${pointsSaved} points saved successfully.`)
                    })
                  } else if (this.persistTimer === null) {
                    // A point arriving inside the throttle window has no later persist
                    // guaranteed: if no further point ever arrives, it would sit in memory
                    // until the service worker is suspended and be lost. Schedule one.
                    this.persistTimer = setTimeout(() => {
                      this.persistTimer = null

                      this.persistDataPoints()
                        .then((pointsSaved: number) => {
                          console.log(`[rex-passive-data-kit] ${pointsSaved} points saved successfully.`)
                      })
                    }, 1100)
                  }
                })
            }

            payload.dataPoint.enqueuedAt = Date.now() / 1000

            const configString = stringify(configuration)

            if (configString !== undefined) {
              rexCorePlugin.generateHash(configString)
              .then((configHash) => {
                payload.dataPoint.configurationHash = `${configHash}`

                persistPoint(payload)
              })
            } else {
                persistPoint(payload)
            }
            
          }
        })
  }

  async persistDataPoints() {
    return new Promise<number>((resolve) => {
      if (this.persistTimer !== null) {
        clearTimeout(this.persistTimer)

        this.persistTimer = null
      }

      this.lastPersisted = Date.now()

      let pointsSaved = 0

      const storePoint = () => {
        if (this.queuedPoints.length === 0 || this.database === null) {
          resolve(pointsSaved)
        } else {
          const objectStore = this.database.transaction(['dataPoints'], 'readwrite').objectStore('dataPoints')

          const point: REXPDKDataPointDBRecord | undefined = this.queuedPoints.pop()

          if (point !== undefined) {
            const request = objectStore.add(JSON.parse(JSON.stringify(point)))

            request.onsuccess = function (event) { // eslint-disable-line @typescript-eslint/no-unused-vars
              console.log(`[rex-passive-data-kit] Data point saved successfully: ${point.generatorId}.`)

              pointsSaved += 1

              storePoint()
            }

            request.onerror = function (event) {
              console.log(`[rex-passive-data-kit] Data point enqueuing failed: ${point.generatorId}.`)
              console.log(event)

              resolve(pointsSaved)
            }
          }
        }
      }

      storePoint()
    })
  }

  // Moves the enqueue-time fields the module stamps on each point into the
  // server-facing 'passive-data-metadata' envelope. Shared by both transports:
  // an override that reimplements this drifts from it (see Keystone's copy,
  // which missed 'enqueued-at' for a month).
  stampPointMetadata(points:REXPDKDataPoint[]) {
    const manifest = chrome.runtime.getManifest()

    const userAgent = manifest.name + '/' + manifest.version + ' ' + navigator.userAgent

    for (let i = 0; i < points.length; i++) {
      let pointDate:number|undefined = points[i].date

      if (pointDate === undefined) {
        pointDate = Date.now()
      }

      const metadata: REXPDKPointMetadata = {
        source: `${this.identifier}`,
        generator: points[i].generatorId + ': ' + userAgent,
        'generator-id': points[i].generatorId,
        timestamp: pointDate / 1000,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      }

      if (points[i].configurationHash !== undefined) {
        metadata['configuration-hash'] = points[i].configurationHash

        delete points[i].configurationHash
      }

      if (points[i].enqueuedAt !== undefined) {
        metadata['enqueued-at'] = points[i].enqueuedAt

        delete points[i].enqueuedAt
      }

      if (points[i].date === undefined) {
        points[i].date = (new Date()).getTime()
      }

      points[i]['passive-data-metadata'] = metadata
    }
  }

  async uploadBundle(points:REXPDKDataPoint[]) {
    this.stampPointMetadata(points)

    if (this.endpointVersion === 'v3') {
      return this.putBundle(points)
    }

    return this.postBundle(points)
  }

  // v3 ingest: raw gzip bytes authorized by a bearer credential, with the
  // participant identified by header so neither token nor identifier lands in
  // the URL.
  async putBundle(points:REXPDKDataPoint[]) {
    if (this.uploadUrl === '') {
      throw new Error('Unable to upload data bundle: passive_data_kit.endpoint is missing.')
    }

    if (this.bearerToken === '') {
      throw new Error('Unable to upload data bundle: passive_data_kit.authorization.token is missing.')
    }

    if (this.identifier === '' || this.identifier === 'undefined') {
      throw new Error('Unable to upload data bundle: participant identifier is missing.')
    }

    const stream = new Blob([JSON.stringify(points, null, 2)])
      .stream()
      .pipeThrough(new CompressionStream('gzip'))

    const body = await new Response(stream).arrayBuffer()

    console.log(`[rex-passive-data-kit] Upload to "${this.uploadUrl}"...`)

    const response = await fetch(this.uploadUrl, {
      method: 'PUT',
      mode: 'cors',
      cache: 'no-cache',
      headers: {
        'Authorization': `Bearer ${this.bearerToken}`,
        'Content-Type': 'application/json',
        'Content-Encoding': 'gzip',
        'X-PDK-IDENTIFIER': this.identifier
      },
      redirect: 'follow',
      referrerPolicy: 'no-referrer',
      body
    })

    const reply = await this.replyOrAccepted(response)

    if (response.ok === false) {
      throw new REXPDKUploadError(response.status, reply)
    }

    return reply
  }

  // A 2xx with no body is an accepted bundle, not a parse failure: caches ahead
  // of the ingest endpoint answer a stored PUT with no content at all.
  async replyOrAccepted(response: Response): Promise<any> { // eslint-disable-line @typescript-eslint/no-explicit-any
    const text = await response.text()

    if (text.trim() === '') {
      return {
        message: 'Data bundle added successfully, and ready for processing.',
        added: true
      }
    }

    try {
      return JSON.parse(text)
    } catch (error) {
      if (response.ok) {
        return {
          message: 'Data bundle added successfully, and ready for processing.',
          added: true
        }
      }

      return {
        error: text,
        parse_error: `${error}`
      }
    }
  }

  async postBundle(points:REXPDKDataPoint[]) {
    return new Promise<any>((resolve, reject) => { // eslint-disable-line @typescript-eslint/no-explicit-any
      const keyPair = nacl.box.keyPair() // eslint-disable-line @typescript-eslint/no-unused-vars

      const serverPublicKey = naclUtil.decodeBase64(this.serverKey) // eslint-disable-line @typescript-eslint/no-unused-vars

      // pdk.encryptFields(serverPublicKey, keyPair.secretKey, points[i])
      // metadata['generated-key'] = nacl.util.encodeBase64(keyPair.publicKey)

      const dataString = JSON.stringify(points, null, 2)

      const byteArray = new TextEncoder().encode(dataString)
      const cs = new CompressionStream('gzip')
      const writer = cs.writable.getWriter()
      writer.write(byteArray)
      writer.close()

      const compressedResponse = new Response(cs.readable)

      compressedResponse.arrayBuffer()
        .then((buffer) => {
          const compressedBase64 = this.blobToB64(buffer)

          console.log(`[rex-passive-data-kit] Upload to "${this.uploadUrl}"...`)

          fetch(this.uploadUrl, {
            method: 'POST',
            mode: 'cors', // no-cors, *cors, same-origin
            cache: 'no-cache', // *default, no-cache, reload, force-cache, only-if-cached
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded',
              'X-PDK-IDENTIFIER': this.identifier
            },
            redirect: 'follow', // manual, *follow, error
            referrerPolicy: 'no-referrer', // no-referrer, *no-referrer-when-downgrade, origin, origin-when-cross-origin, same-origin, strict-origin, strict-origin-when-cross-origin, unsafe-url
            body: new URLSearchParams({
              compression: 'gzip',
              payload: compressedBase64
            })
          }) // body data type must match "Content-Type" header
            .then((response) => {
              response.json().then((reply) => {
                if (response.ok) {
                  resolve(reply)
                } else {
                  reject(reply)
                }
              }).catch((err) => {
                reject(`Response from PDK server was not JSON. Status code: ${response.status} Error: ${err}`)
              })
            })
            .catch((error) => {
              console.error('Error:', error)

              reject(error)
            })
        })
    })
  }

  updateDataPoints(dataPoints: REXPDKDataPointDBRecord[]) {
    return new Promise<void>((resolve, reject) => {
      if (dataPoints.length === 0 || this.database === null) {
        resolve()
        return
      }

      const dataPoint: REXPDKDataPointDBRecord | undefined = dataPoints.pop()

      if (dataPoint === undefined) {
        resolve()
        return
      }

      const request = this.database.transaction(['dataPoints'], 'readwrite')
        .objectStore('dataPoints')
        .put(dataPoint)

      request.onsuccess = (event) => { // eslint-disable-line @typescript-eslint/no-unused-vars
        this.updateDataPoints(dataPoints).then(resolve, reject)
      }

      request.onerror = (error) => {
        console.log('[rex-passive-data-kit] The data update has has failed.')
        console.log(error)

        reject(error)
      }
    })
  }

  async uploadQueuedDataPoints(progressCallback: any, responses:any[] = []) { // eslint-disable-line @typescript-eslint/no-explicit-any
    // Serialize uploads: overlapping calls (a scheduled upload plus a
    // config-apply notification, for instance) would read the same
    // untransmitted points and transmit them twice. The flag must be set
    // synchronously, before any await, or two same-tick calls both pass the
    // check. In-memory on purpose: a killed worker restarts with it clear.
    if (this.currentlyUploading) {
      return Promise.reject('Still uploading data points. Skipping...')
    }

    this.currentlyUploading = true

    // Points enqueued inside the persist throttle window are still in memory;
    // persist them first so the IndexedDB read below sees everything enqueued so far.
    await this.persistDataPoints()

    return new Promise<any>((resolveUploadQueued, reject) => { // eslint-disable-line @typescript-eslint/no-explicit-any
      if (this.database === null) {
        this.currentlyUploading = false

        reject('Database not yet open. Skipping')
      } else if (this.identifier === undefined || this.identifier === null) {
        this.currentlyUploading = false

        reject('Identifier not set. Skipping')
      } else {
        const index = this.database.transaction(['dataPoints'], 'readonly')
          .objectStore('dataPoints')
          .index('transmitted')

        const countRequest = index.count(0)

        countRequest.onsuccess = () => {
          console.log(`[rex-passive-data-kit] Remaining data points: ${countRequest.result}`)

          const request = index.getAll(0, 64)

          request.onsuccess = () => {
            const pendingItems: REXPDKDataPointDBRecord[] = request.result

            if (pendingItems.length === 0) {
              this.currentlyUploading = false

              resolveUploadQueued(responses)
            } else {
              const toTransmit: REXPDKDataPointDBRecord[] = []
              const xmitBundle: REXPDKDataPoint[] = []

              const pendingRemaining = pendingItems.length

              console.log(`[rex-passive-data-kit] Remaining data points (this bundle): ${pendingRemaining}`)

              progressCallback(pendingRemaining)

              let bundleLength = 0

              for (let i = 0; i < pendingRemaining && bundleLength < (128 * 1024); i++) {
                const pendingItem: REXPDKDataPointDBRecord = pendingItems[i]

                pendingItem.transmitted = new Date().getTime()

                pendingItem.dataPoint.date = pendingItem.date
                pendingItem.dataPoint.generatorId = pendingItem.generatorId

                toTransmit.push(pendingItem)
                xmitBundle.push(pendingItem.dataPoint)

                const bundleString = JSON.stringify(pendingItem.dataPoint)

                bundleLength += bundleString.length
              }

              const status: REXPDKStatusDataPoint = {
                'pending-points': pendingRemaining,
                generatorId: 'pdk-system-status'
              }

              const transmitPromise = new Promise<void>((resolveStatus) => {
                const pending:string[] = []

                const markResolved = function(token: string) {
                  const tokenIndex = pending.indexOf(token)

                  if (tokenIndex >= 0) {
                    pending.splice(tokenIndex, 1)
                  }

                  if (pending.length === 0) {
                    resolveStatus()
                  }
                }

                pending.push('pdk-annotate')

                this.annotateDataPoint(status)
                  .then(() => {
                    markResolved('pdk-annotate')
                  })

                pending.push('config-hash')

                rexCorePlugin.fetchConfiguration().then((configuration: REXConfiguration) => {
                  this.normalizeConfiguration(configuration)

                  const configString = stringify(configuration)

                  if (configString !== undefined) {
                    rexCorePlugin.generateHash(configString)
                    .then((configHash) => {
                      status.configurationHash = `${configHash}`

                      markResolved('config-hash')
                    })
                  } else {
                    markResolved('config-hash')
                  }
                })

                if (chrome.system !== undefined) {
                  if (chrome.system.cpu !== undefined) {
                    pending.push('cpu-info')

                    chrome.system.cpu.getInfo().then((cpuInfo: chrome.system.cpu.CpuInfo) => {
                      status['cpu-info'] = cpuInfo

                      markResolved('cpu-info')
                    })
                  }

                  if (chrome.system.display !== undefined) {
                    pending.push('display-info')

                    chrome.system.display.getInfo().then((displayUnitInfo: chrome.system.display.DisplayUnitInfo[]) => {
                      status['display-info'] = displayUnitInfo

                      markResolved('display-info')
                    })
                  }

                  if (chrome.system.memory !== undefined) {
                    pending.push('memory-info')

                    chrome.system.memory.getInfo().then((memoryInfo: chrome.system.memory.MemoryInfo) => {
                      status['memory-info'] = memoryInfo

                      markResolved('memory-info')
                    })
                  }

                  if (chrome.system.storage !== undefined) {
                    pending.push('storage-info')

                    chrome.system.storage.getInfo().then((storageUnitInfo: chrome.system.storage.StorageUnitInfo[]) => {
                      status['storage-info'] = storageUnitInfo

                      markResolved('storage-info')
                    })
                  }

                  if (chrome.storage.local !== undefined) {
                    pending.push('local-storage-bytes')

                    chrome.storage.local.getBytesInUse().then((bytesUsed:number) => {
                      status['local-storage-bytes'] = bytesUsed

                        markResolved('local-storage-bytes')
                    })
                  }
                } else {
                  markResolved('finish')
                }
              })
              
              transmitPromise.then(() => {
                xmitBundle.push(status)

                if (toTransmit.length === 0) {
                  this.currentlyUploading = false

                  responses.push('after-transit')

                  resolveUploadQueued(responses)
                } else {
                  this.uploadBundle(xmitBundle)
                    .then((responseData) => {
                      responses.push(responseData)

                      this.updateDataPoints(toTransmit).then(() => {
                        this.currentlyUploading = false

                        this.uploadQueuedDataPoints(progressCallback, responses).then((promiseResponses) => {
                          resolveUploadQueued(promiseResponses)
                        })
                      })
                    }, (error) => {
                      this.currentlyUploading = false

                      reject(error)
                    })
                    .catch((error) => {
                      this.currentlyUploading = false

                      console.log('[rex-passive-data-kit] PDK upload error:')
                      console.log(error)

                      reject(`Error uploading data points: ${error}`)
                    })
                }
              })
            }
          }

          request.onerror = (event) => {
            this.currentlyUploading = false

            console.log('[rex-passive-data-kit] PDK database error. Unable to retrieve pending points.')
            console.log(event)

            this.currentlyUploading = false

            reject(`Database error: ${event}`)
          }
        }

        countRequest.onerror = (event) => {
          this.currentlyUploading = false

          console.log('[rex-passive-data-kit] PDK database error. Unable to retrieve count of pending points.')
          console.log(event)

          this.currentlyUploading = false

          reject(`Database error: ${event}`)
        }
      }
    })
  }

  async transmitDataPoint(event: REXPDKEvent) {
    return new Promise<any>((resolve) => { // eslint-disable-line @typescript-eslint/no-explicit-any
      const manifest = chrome.runtime.getManifest()

      const pointUrl = this.uploadUrl.replaceAll('add-bundle.json', 'add-point.json') // TODO: Make configurable

      const generatorId = event.name
      const userAgent = manifest.name + '/' + manifest.version + ' ' + navigator.userAgent

      if (this.identifier === undefined) {
        this.identifier = event['source']
      }

      if (this.identifier === undefined || this.identifier === null || this.identifier === '') {
        console.warn('[rex-passive-data-kit] Identifier not set. Skipping synchronous point transmission.')

        resolve({
          logged: false,
          url: pointUrl,
          status: 'Identifier not set. Skipping'
        })

        return
      }

      const pointPayload:REXPDKDataPoint = {
        'passive-data-metadata': {
          source: `${this.identifier}`,
          generator: generatorId + ': ' + userAgent,
          'generator-id': generatorId,
          timestamp: Date.now() / 1000,
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        }
      }

      Object.assign(pointPayload, event)

      const transmitPoint = ((dataPoint:REXPDKDataPoint) => {
        console.log(`[rex-passive-data-kit]: Transmitting synchronous point (${pointUrl})...`)
        console.log(dataPoint)

        fetch(pointUrl, {
          method: 'POST',
          mode: 'cors', // no-cors, *cors, same-origin
          cache: 'no-cache', // *default, no-cache, reload, force-cache, only-if-cached
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'X-PDK-IDENTIFIER': this.identifier
          },
          redirect: 'follow', // manual, *follow, error
          referrerPolicy: 'no-referrer', // no-referrer, *no-referrer-when-downgrade, origin, origin-when-cross-origin, same-origin, strict-origin, strict-origin-when-cross-origin, unsafe-url
          body: new URLSearchParams({
            payload: JSON.stringify(dataPoint)
          })
        }).then((response) => {
          console.log(`[rex-passive-data-kit]: Response received...`)
          console.log(response)

          if (response.ok) {
            response.json().then((reply) => {
              resolve({
                logged: true,
                url: pointUrl,
                message: reply['message']
              })
            }, (error) => {
              console.log(`[rex-passive-data-kit] Error parsing JSON from (${pointUrl})...`)
              console.log(error)
            
              resolve({
                logged: false,
                url: pointUrl,
                status: `Error parsing JSON from ${pointUrl}: ${error.message}`
              })
            }) 
          } else {
            resolve({
              logged: false,
              url: pointUrl,
              status: `Response status from ${pointUrl}: ${response.status}`
            })
          }
        }, (error) => {
          console.log(`[rex-passive-data-kit] Error connecting to (${pointUrl})...`)
          console.log(error)

          resolve({
            logged: false,
            url: pointUrl,
            status: `Error connecting to ${pointUrl}: ${error.message}`
          })
        })
      })

      this.annotateDataPoint(pointPayload).then(() => {
        rexCorePlugin.fetchConfiguration()
          .then((configuration: REXConfiguration) => {
            const passiveDataKitConfig: REXPDKConfiguration = (configuration as any)['passive_data_kit'] // eslint-disable-line @typescript-eslint/no-explicit-any

            if (passiveDataKitConfig !== undefined) {
              this.updateConfiguration(passiveDataKitConfig)
            }

            if (pointPayload['passive-data-metadata'] !== undefined) {
              pointPayload['passive-data-metadata']['enqueued-at'] = (Date.now() / 1000)
            }

            const configString = stringify(configuration)

            if (configString !== undefined) {
              rexCorePlugin.generateHash(configString)
              .then((configHash) => {
                if (pointPayload['passive-data-metadata'] !== undefined) {
                  pointPayload['passive-data-metadata']['configuration-hash'] = `${configHash}`
                }

                transmitPoint(pointPayload)
              })
            } else {
              if (pointPayload['passive-data-metadata'] !== undefined) {
                pointPayload['passive-data-metadata']['configuration-hash'] = ''
              }

              transmitPoint(pointPayload)
            }
          })
      })
    })
  }

  annotateDataPoint(dataPoint:REXPDKDataPoint) {
    const pending = [...this.dataPointAnnotators]
    
    return new Promise<void>((resolve) => {
      const nextAnnotation = () => {
        if (pending.length == 0) {
          resolve()
        } else {
          const next = pending.pop()

          if (next !== undefined) {
            next.annotate(dataPoint).then(() => {
              nextAnnotation()
            })
          } else {
            resolve()
          }
        }
      }

      nextAnnotation()
    })
  }

  encryptFields(payload:any) { // eslint-disable-line @typescript-eslint/no-explicit-any
    if (this.serverFieldKey === null || this.localFieldKey === null) {
      return
    }

    for (const itemKey in payload) {
      const value = payload[itemKey]

      const toRemove: string[] = []

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
        value.forEach((valueItem) => {
          if (valueItem.constructor.name === 'Object') {
            this.encryptFields(valueItem)
          }
        })
      }
    }
  }

  normalizeConfiguration(configuration:REXConfiguration) {
    if (configuration['passive_data_kit'] !== undefined) {
      if (configuration['passive_data_kit'].identifier !== undefined) {
        delete configuration['passive_data_kit'].identifier
      }

      if (configuration.token !== undefined) {
        delete configuration.token
      }

      if (configuration['switch_url'] !== undefined) {
        delete configuration['switch_url']
      }
    }
  }

  handleMessage(message:any, sender:any, sendResponse:(response:any) => void):boolean  { // eslint-disable-line @typescript-eslint/no-explicit-any
    if (message.messageType == 'transmitSynchronousEvent') {
      REXContentProcessorManager.getInstance().processContent(message.event)
        .then((processed) => {
          console.log(`[rex-passive-data-kit] transmitSynchronousEvent - processed content`)
          console.log(processed)

          this.transmitDataPoint(processed).then((response) => {
            sendResponse(response)
          })
        })

      return true
    }

    return false
  }
}

const plugin = new PassiveDataKitModule()

registerREXModule(plugin)

export default plugin
