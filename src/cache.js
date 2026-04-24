class Cache {
  constructor(options = {}) {
    this.ttl = options.ttl || 5 * 60 * 1000; // 5 minutes default
    this.maxSize = options.maxSize || 1000; // Max cache entries
    this.store = new Map();
    this.accessOrder = []; // For LRU tracking
    this.stats = {
      hits: 0,
      misses: 0,
      evictions: 0,
      size: 0
    };
  }

  get(key) {
    const entry = this.store.get(key);
    
    if (!entry) {
      this.stats.misses++;
      return null;
    }
    
    // Check TTL
    if (Date.now() > entry.expiry) {
      this.store.delete(key);
      this._removeFromAccessOrder(key);
      this.stats.size--;
      this.stats.misses++;
      return null;
    }
    
    // Update access order for LRU
    this._updateAccessOrder(key);
    this.stats.hits++;
    
    return entry.value;
  }

  set(key, value, customTTL = null) {
    const ttl = customTTL || this.ttl;
    const expiry = Date.now() + ttl;
    
    // Evict if cache is full
    if (this.store.size >= this.maxSize) {
      this._evictLRU();
    }
    
    // Add or update entry
    const isNew = !this.store.has(key);
    this.store.set(key, { value, expiry });
    
    if (isNew) {
      this.stats.size++;
    }
    
    this._updateAccessOrder(key);
    
    return value;
  }

  delete(key) {
    const existed = this.store.delete(key);
    if (existed) {
      this._removeFromAccessOrder(key);
      this.stats.size--;
    }
    return existed;
  }

  clear() {
    this.store.clear();
    this.accessOrder = [];
    this.stats.size = 0;
    this.stats.evictions = 0;
  }

  _updateAccessOrder(key) {
    // Remove key from current position
    const index = this.accessOrder.indexOf(key);
    if (index !== -1) {
      this.accessOrder.splice(index, 1);
    }
    
    // Add to end (most recently used)
    this.accessOrder.push(key);
  }

  _removeFromAccessOrder(key) {
    const index = this.accessOrder.indexOf(key);
    if (index !== -1) {
      this.accessOrder.splice(index, 1);
    }
  }

  _evictLRU() {
    if (this.accessOrder.length === 0) return;
    
    const lruKey = this.accessOrder.shift();
    this.store.delete(lruKey);
    this.stats.size--;
    this.stats.evictions++;
  }

  getStats() {
    return {
      ...this.stats,
      ttl: this.ttl,
      maxSize: this.maxSize,
      currentSize: this.store.size
    };
  }

  // Cache group support
  invalidateGroup(groupKey) {
    let deletedCount = 0;
    for (const [key, entry] of this.store.entries()) {
      if (key.startsWith(`${groupKey}:`)) {
        this.store.delete(key);
        this._removeFromAccessOrder(key);
        deletedCount++;
      }
    }
    this.stats.size -= deletedCount;
    return deletedCount;
  }

  // Utility to generate cache key
  static generateKey(toolName, args) {
    const argsHash = JSON.stringify(args || {});
    return `${toolName}:${Buffer.from(argsHash).toString('base64').slice(0, 32)}`;
  }
}

module.exports = Cache;