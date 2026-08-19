// Retains the data points the mock server has accepted so a test can ask what
// the server actually received, rather than trusting what the client believed
// it sent. Points are looked up by their `passive-data-metadata.timestamp`
// (epoch seconds), which a test can pin by setting `date` on the point it
// dispatches.
//
// The store holds points, never bundles. A bundle is a transport envelope with
// no timestamp of its own, so storing one would leave nothing to query by.
// Bundle routes unwrap and record each point they contain.
//
// In-memory and process-lifetime only: the server is started per test run and
// the store is not meant to outlive it.
export class DataPointStore {
  constructor() {
    this.points = []
  }

  // Callers record only after a payload has passed validation. The store stands
  // for what the server persisted, and a rejected bundle was never written, so
  // keeping it would report points the server does not have. Do not move these
  // calls ahead of the 400 paths.
  recordPoint(dataPoint) {
    this.points.push(dataPoint)
  }

  // `dataPoints` is a decoded bundle payload: the array of points it carried.
  recordPoints(dataPoints) {
    for (const dataPoint of dataPoints) {
      this.recordPoint(dataPoint)
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
