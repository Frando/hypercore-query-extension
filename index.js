var { EventEmitter } = require('events')
var { Readable } = require('readable-stream')
var onend = require('end-of-stream')
var messages = require('./messages.js')
var types = {
  Open: 0,
  Read: 1,
  Control: 2,
  QueryDef: 3,
  Response: 4,
  FeedDef: 5
}
var codes = messages.Control.ControlCode

module.exports = Query

function Query (mstore, opts) {
  if (!(this instanceof Query)) return new Query(mstore, opts)
  if (!opts) opts = {}
  this._mstore = mstore
  this._api = opts.api || {}
  this._queryDefs = {}
  this._feedDefs = {}
  this._queries = {}
  this._readers = {}
  this._sentQueries = {}
  this._sentQueryId = 0
  this._sentQueryDefs = {}
  this._sentQueryDefId = 0
}
Query.prototype = Object.create(EventEmitter.prototype)

Query.prototype.query = function (name, data) {
  var self = this
  if (!self._sentQueries.hasOwnProperty(name)) {
    var qid = self._sentQueryDefId++
    self._sentQueriesDefs[name] = qid
    self._ext.send(messages.QueryDef.encode({ qid, name }))
  }
  var id = self._sentQueryId++
  self._sentQueries[id] = new Readable({
    objectMode: true,
    read: function (n) {
      self._ext.send(messages.Read.encode({ id, n }))
    }
  })
  self._ext.send(messages.Open.encode({
    id,
    query_id: self._sentQueryDefs[name],
    data
  }))
  return self._sentQueries[id]
}

Query.prototype._handle = function (msg) {
  if (msg[0] === types.Open) {
    this._handleOpen(messages.Open.decode(msg, 1))
  } else if (msg[0] === types.Read) {
    this._handleRead(messages.Read.decode(msg, 1))
  } else if (msg[0] === types.Control) {
    this._handleControl(messages.Control.decode(msg, 1))
  } else if (msg[0] === types.QueryDef) {
    var m = messages.Close.decode(msg.slice(1))
    this._queryDefs[m.id] = m.name
  } else if (msg[0] === types.Response) {
    var m = messages.Response.decode(msg, 1)
    var q = this._sentQueries[m.query_id]
    if (!q) return
    q.push({
      key: this._feedDefs[m.result.id],
      seq: m.result.seq
    })
  } else if (msg[0] === types.FeedDef) {
    var m = messages.FeedDef.decode(msg, 1)
    this._feedDefs[m.id] = m.key
  }
}

Query.prototype._handleOpen = function (m) {
  var self = this
  var name = self._queryDefs[m.query_id]
  if (!self._api.hasOwnProperty(name)) return
  if (typeof self._api[name] !== 'function') return
  var q = self._api[name](m.data)
  if (!q || typeof q.pipe !== 'function') return
  self._queries[m.id] = q
  self._readers[m.id] = reader(q)
  onend(q, function () {
    delete self._queries[m.id]
    delete self._readers[m.id]
  })
}

Query.prototype._handleRead = function (m) {
  var self = this
  var q = self._queries[m.id]
  if (!q) return
  self._readers[m.id](q, m.n, function (res) {
    self._ext.send(messages.Response.encode({
      query_id: m.id,
      result: res
    }))
  })
}

Query.prototype._handleControl = function (m) {
  if (m.code === codes.CLOSE) {
    var q = this._queries[m.id]
    if (q && typeof q.close === 'function') q.close()
    delete this._queries[m.id]
  } else if (m.code === codes.DESTROY) {
    var q = this._queries[m.id]
    if (q && typeof q.destroy === 'function') q.destroy()
    delete this._queries[m.id]
  }
}

Query.prototype.register = function (p, extName) {
  var self = this
  self._ext = p.registerExtension(extName, {
    encoding: 'binary',
    onmessage: function (msg, peer) {
      self._handle(msg)
    },
    onerror: function (err) {
      self.emit('error', err)
    }
  })
  return ext
}

function reader (stream) {
  var queue = [], ready = true
  stream.on('readable', onreadable)
  stream.on('error', onerror)
  return function (n, cb) {
    if (!ready) return queue.push([Math.max(n || 1, 1),cb])
  }
  function onreadable () {
    ready = true
    read()
  }
  function read () {
    while (ready) {
      if (queue.length === 0) return
      var q = queue[0]
      var res = stream.read(q[0])
      if (res === null) break
      q[1](null, res)
      if (--q[0] === 0) queue.shift()
    }
    ready = false
  }
  function onerror (err) {
    stream.emit('error', err)
  }
}