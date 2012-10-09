
/**
 * Module dependencies.
 */

var request = require('superagent')
  , query = require('mongo-query')
  , debug = require('debug')('mydb-client:document')
  , dot, type, Emitter;

try {
  dot = require('dot');
  type = require('type');
  Emitter = require('emitter');
} catch(e){
  dot = require('dot-component');
  type = require('type-component');
  Emitter = require('emitter-component');
}

/**
 * Module exports.
 */

module.exports = Document;

/**
 * Document constructor.
 *
 * @param {Manager} originating manager.
 * @api public
 */

function Document(manager){
  this.$_manager = manager;
  this.$_readyState = 'unloaded';
}

/**
 * Mixes in `Emitter`.
 */

Emitter(Document.prototype);

/**
 * Returns the manager instance.
 *
 * @return {Manager} mng this doc was created from
 * @api public
 */

Document.prototype.$manager = function(){
  return this.$_manager;
};

/**
 * Returns the subscription id.
 *
 * @return {String} subscription id
 * @api public
 */

Document.prototype.$sid = function(){
  return this.$_sid;
};

/**
 * Returns the resource url.
 *
 * @return {String} url
 * @api public
 */

Document.prototype.$url = function(){
  return this.$_url;
};

/**
 * Returns the readyState.
 *
 * @param {String} readyState if setting
 * @return {Document|String} `this` if setting, or state string
 * @api public
 */

Document.prototype.$readyState = function(s){
  if (s) {
    debug('setting state %s', s);
    this.$_readyState = s;
    this.emit('$state', s);
    this.emit('$state:' + s);
    return this;
  } else {
    return this.$_readyState;
  }
};

/**
 * Override `on`.
 *
 * @param {String} key, or regular event
 * @param {String} optional, operation (eg: `set`, `$push`, `push`)
 * @param {Function} callback
 * @api public
 */

Document.prototype.on = function(key, op, fn){
  if ('string' == type(op)) {
    key = key + '$' + op.replace(/^\$/, '');
    op = fn;
  }
  return Emitter.prototype.on.call(this, key, op);
};

/**
 * Override `once`.
 *
 * @param {String} key, or regular event
 * @param {String} optional, operation (eg: `set`, `$push`, `push`)
 * @param {Function} callback
 * @api public
 */

Document.prototype.once = function(key, op, fn){
  if ('string' == type(op)) {
    key = key + '$' + op.replace(/^\$/, '');
    op = fn;
  }
  return Emitter.prototype.once.call(this, key, op);
};

/**
 * Override `off`.
 *
 * @param {String} key, or regular event
 * @param {String} optional, operation (eg: `set`, `$push`, `push`)
 * @param {Function} callback
 * @api public
 */

Document.prototype.off =
Document.prototype.removeListener = function(key, op, fn){
  if ('string' == type(op)) {
    key = key + '$' + op.replace(/^\$/, '');
    op = fn;
  }
  return Emitter.prototype.off.call(this, key, op);
};

/**
 * Override `listeners`.
 *
 * @param {String} key, or regular event
 * @param {String} optional, operation (eg: `set`, `$push`, `push`)
 * @api public
 */

Document.prototype.listeners = function(key, op){
  if (op) key = key + '$' + op.replace(/^\$/, '');
  return Emitter.prototype.listeners.call(this, key);
};

/**
 * Override `hasListeners`.
 *
 * @param {String} key, or regular event
 * @param {String} optional, operation (eg: `set`, `$push`, `push`)
 * @api public
 */

Document.prototype.hasListeners = function(key, op){
  if (op) key = key + '$' + op.replace(/^\$/, '');
  return Emitter.prototype.hasListeners.call(this, key);
};

/**
 * Called with the object payload.
 *
 * @param {Object} doc payload
 * @api private
 */

Document.prototype.$payload = function(obj){
  debug('got payload %j', obj);
  for (var i in obj) {
    if (obj.hasOwnProperty(i)) {
      this[i] = obj[i];
    }
  }
  this.$readyState('loaded');
};

/**
 * Called with each operation.
 *
 * @api private
 */

Document.prototype.$op = function(data){
  debug('got operation %j', data);
  var log = query(this, data[0], data[1]);

  for (var i = 0; i < log.length; i++) {
    var obj = log[i];
    var val = obj.value;
    var key = obj.key;
    var type = obj.op;

    // express $pop as a $pull
    if ('$pop' == type) {
      this.emit(key + '$pull', val, obj);
    }

    // express $rename as $unset + $set
    if ('$unset' == type) {
      this.emit(key + '$unset', null, obj);
      this.emit(val + '$set', this.get(val), obj);
    }

    // express $pushAll/$pullAll as multiple single ops
    if (/All/.test(type)) {
      for (var ii = 0; ii < val.length; i++) {
        this.emit(key + type.replace(/All/, ''), val[ii], obj);
      }
    } else {
      this.emit(key + type, val, obj);
    }

    this.emit(key, this.get(key), obj);
  }
};

/**
 * Called when the document is ready.
 *
 * @param {Function} callback
 * @return {Document} for chaining
 * @api public
 */

Document.prototype.ready = function(fn){
  if ('loaded' == this.$readyState) {
    setTimeout(fn, 0);
  } else {
    this.once('$state:loaded', fn);
  }
  return this;
};

/**
 * Connects to the given url.
 *
 * @return {Document} for chaining
 * @api public
 */

Document.prototype.load = function(url, fn){
  if ('unloaded' != this.$readyState()) {
    throw new Error('Trying to load resource, but doc is not unloaded');
  }

  debug('subscribing to resource %s', url);

  var manager = this.$manager()
    , socket = manager.socket;

  // mark ready state as loading the doc
  this.$readyState('loading');

  // if in node, try to prefix the url if relative
  if ('undefined' != typeof process && '/' == url[0]) {
    url = (socket.secure ? 'https' : 'http') + '://' +
            socket.host + ':' + socket.port + url;
  }

  // keep track of current url
  this.$_url = url;
  url = url + (~url.indexOf('?') ? '' : '?') + 'my=1&t=' + Date.now();

  // get the subscription id over REST
  var self = this;
  var xhr = this.$xhr = request.get(url, function(res){
    // XXX: remove this check when superagent gets `abort`
    if (xhr == self.$xhr) {
      if (res.ok) {
        debug('got subscription id "%s"', res.text);
        self.$_sid = res.text;
        manager.subscribe(res.text, self);
      } else {
        debug('subscription error');
      }
    } else {
      debug('ignoring outdated resource subscription %s', res.text);
    }
  });

  if (fn) this.ready(fn);
  return this;
};

/**
 * Gets the given key.
 *
 * @param {String} key
 * @param {Function} optional, if supplied wraps with `ready`
 * @return {Document} for chaining
 * @api public
 */

Document.prototype.get = function(key, fn){
  var obj = this;

  function get(){
    return dot.get(obj, key);
  }

  if (fn) {
    this.ready(function(){
      fn(get());
    });
  } else {
    return get();
  }

  return this;
};

/**
 * Calls with the initial value + subsequent ones.
 *
 * @param {String} key
 * @param {Function} callback
 * @return {Document} for chaining
 * @api public
 */

Document.prototype.upon = function(key, fn){
  this.get(key, fn);
  this.on(key, fn);
  return this;
};

/**
 * Loops through the given key.
 *
 * @param {String} key
 * @param {Function} callback
 * @return {Document} for chaining
 * @api public
 */

Document.prototype.each = function(key, fn){
  var self = this;
  this.get(key, function(v){
    if ('array' == type(v)) v.forEach(fn);
    self.on(key, 'push', fn);
  });
  return this;
};

/**
 * Destroys the subscription (if any)
 *
 * @param {Function} optional, callback
 * @return {Document} for chaining
 * @api public
 */

Document.prototype.destroy = function(fn){
  switch (this.$readyState()) {
    case 'loading':
      if (this.xhr.abort) {
        // XXX: remove this check when superagent gets `abort`
        this.$xhr.abort();
      }
      this.$xhr = null;
      break;

    case 'unloading':
    case 'unloaded':
      throw new Error('Trying to destroy invalid resource');

    default:
      var sid = this.$sid();
      var self = this;

      // mark ready state
      this.$readyState('unloading');

      // unsubscribe
      this.$manager().on('unsubscribe', function unsubscribe(s){
        if (s == sid) {
          debug('unsubscription "%s" complete', s);
          fn && fn();
          self.$readyState('unloaded');
          self.$manager().off('unsubscribe', unsubscribe);
        }
      });
      this.$manager().unsubscribe(this.$sid(), this);
      break;
  }
  return this;
};
