import { gunzipSync } from 'node:zlib';
import { Buffer } from 'node:buffer';

import express from 'express'
import multer from 'multer'

const app = express();
const port = 9090;

// Registered ahead of the JSON/urlencoded parsers and scoped to the v3 routes:
// those receive raw gzip bytes, which express.json() would otherwise consume
// (leaving nothing for a later raw parser to read).
// Scoped to /v3 and registered ahead of the JSON/urlencoded parsers, which would
// otherwise consume the body. body-parser honors Content-Encoding and hands the
// route an already-decompressed buffer, same as the real ingest endpoint.
app.use('/v3', express.raw({ type: '*/*', limit: '50mb' }))

app.use(express.json()) // for parsing application/json
app.use(express.urlencoded({ extended: true })) // for parsing application/x-www-form-urlencoded

const upload = multer()

app.get('/', (request, response) => {
  response.send('The only way to pass a test is to take the test.')
})

app.get('/headers', (request, response) => {
  response.statusCode = 200;
  response.setHeader('Content-Type', 'application/json')

  response.send(JSON.stringify(request.headers, null, '  '))
})

app.post('/post', upload.none(), (request, response) => {
  response.statusCode = 200;
  response.setHeader('Content-Type', 'application/json')

  if ([null, undefined, ''].includes(request.body)) {
    request.body = {}
  }

  response.send(JSON.stringify(request.body, null, '  '))
})

app.post('/data/add-bundle.json', upload.none(), (request, response) => {
  response.statusCode = 200;
  response.setHeader('Content-Type', 'application/json')

  let reply = {
    'request-headers': request.headers,
    'request-body': request.body
  }

  if ('gzip' == request.body.compression) {
    const buffer = Buffer.from(request.body.payload, 'base64');
    const decompressed = gunzipSync(buffer).toString();

    reply.payload = JSON.parse(decompressed)
  } else {
    reply.payload = JSON.parse(request.body.payload)
  }

  console.error(`/data/add-bundle.json: ${JSON.stringify(reply, null, '  ')}`)

  for (const dataPoint of reply.payload) {
    const metadata = dataPoint['passive-data-metadata']

    let error = null

    if (metadata === undefined) {
      error = '<passive-data-metadata> is missing.'
    }

    if (metadata.source === undefined) {
      error = '<passive-data-metadata.source> is missing.'
    }

    if (metadata['configuration-hash'] === undefined) {
      error = '<passive-data-metadata.configuration-hash> is missing.'
    }

    if (error !== null) {
      console.error(`Error encountered in data point: ${error}`)
      console.error(`/data/add-bundle.json: ${JSON.stringify(dataPoint, null, '  ')}`)
      
      response.statusCode = 400;
      response.send(JSON.stringify({'error': '"passive-data-metadata.source" is missing.'}))

      return
    }
  }

  response.send(JSON.stringify(reply, null, '  '))
})

app.put('/v3/data/bundle', (request, response) => {
  response.setHeader('Content-Type', 'application/json')

  const authorization = request.headers['authorization']

  if (authorization !== 'Bearer test-bearer-token') {
    response.statusCode = 401;
    response.send(JSON.stringify({'error': 'Missing or invalid bearer token.'}))

    return
  }

  if (request.headers['content-encoding'] !== 'gzip') {
    response.statusCode = 400;
    response.send(JSON.stringify({'error': 'Bundle was not gzip-encoded.'}))

    return
  }

  const payload = JSON.parse(Buffer.from(request.body).toString())

  console.error(`/v3/data/bundle: ${JSON.stringify(payload, null, '  ')}`)

  for (const dataPoint of payload) {
    const metadata = dataPoint['passive-data-metadata']

    let error = null

    if (metadata === undefined) {
      error = '<passive-data-metadata> is missing.'
    } else if (metadata.source === undefined) {
      error = '<passive-data-metadata.source> is missing.'
    } else if (metadata['enqueued-at'] === undefined && dataPoint['generatorId'] !== 'pdk-system-status') {
      // pdk-system-status points are synthesized during upload rather than
      // enqueued, so they never carry an enqueuedAt to promote. Same on the
      // legacy POST path; not specific to v3.
      error = '<passive-data-metadata.enqueued-at> is missing.'
    }

    if (error !== null) {
      console.error(`Error encountered in data point: ${error}`)

      response.statusCode = 400;
      response.send(JSON.stringify({'error': error}))

      return
    }
  }

  response.statusCode = 200;
  response.send(JSON.stringify({
    'request-headers': request.headers,
    'payload': payload
  }, null, '  '))
})

// An edge cache ahead of the ingest endpoint answers a stored PUT with no body
// at all; the client must read that as success, not as a parse failure.
app.put('/v3/data/bundle-empty-reply', (request, response) => {
  response.statusCode = 200;
  response.send('')
})

app.post('/data/add-point.json', upload.none(), (request, response) => {
  response.statusCode = 200;
  response.setHeader('Content-Type', 'application/json')

  const dataPoint = JSON.parse(request.body.payload)

  let reply = {
    'request-headers': request.headers,
    'request-body': request.body,
    'post.payload': dataPoint
  }

  console.error(`/data/add-point.json: ${JSON.stringify(reply, null, '  ')}`)

  const metadata = dataPoint['passive-data-metadata']

  let error = null

  if (metadata === undefined) {
    error = '<passive-data-metadata> is missing.'
  }

  if (metadata.source === undefined) {
    error = '<passive-data-metadata.source> is missing.'
  }

  if (metadata['configuration-hash'] === undefined) {
    error = '<passive-data-metadata.configuration-hash> is missing.'
  }

  if (error !== null) {
    console.error(`Error encountered in data point: ${error}`)
    console.error(`/data/add-bundle.json: ${JSON.stringify(dataPoint, null, '  ')}`)
      
    response.statusCode = 400;
    response.send(JSON.stringify({'error': '"passive-data-metadata.source" is missing.'}))

    return
  }

  const replyMessage = {
    message: 'Data point added successfully.'
  }

  response.send(JSON.stringify(replyMessage, null, '  '))
})

app.listen(port, () => {
  console.log(`Server running on port ${port}...`);
})
