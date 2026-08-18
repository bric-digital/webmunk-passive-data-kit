// Retains the data points the mock server has accepted so a test can ask what
// the server actually received, rather than trusting what the client believed
// it sent. Points are looked up by their `passive-data-metadata.timestamp`
// (epoch seconds), which a test can pin by setting `date` on the point it
// enqueues.
//
// In-memory and process-lifetime only: the server is started per test run and
// the store is not meant to outlive it.
export class DataPointStore {
  constructor() {
    this.points = []
  }

  // `dataPoints` is the decoded upload payload: an array for the bundle
  // endpoints, a single point for the add-point endpoint.
  record(dataPoints) {
    for (const dataPoint of [dataPoints].flat()) {
      this.points.push(dataPoint)
    }
  }

  // A tolerance is accepted because timestamps are floats with sub-millisecond
  // precision; callers pinning an exact value can leave it at zero.
  findByTimestamp(timestamp, tolerance = 0) {
    return this.points.filter((dataPoint) => {
      const metadata = dataPoint['passive-data-metadata']

      if (metadata === undefined || metadata.timestamp === undefined) {
        return false
      }

      return Math.abs(metadata.timestamp - timestamp) <= tolerance
    })
  }

  clear() {
    this.points = []
  }

  get size() {
    return this.points.length
  }
}
