const uint64be = require('uint64be')
const raf = require('random-access-file')

const MIN_SIZE = 128
const MIN_BITS = 31 - Math.clz32(MIN_SIZE) - 1

//         | 0         | 1      | 2          | 8      | 16    | 24          | 536    | 537
// header: | <version> | <bits> | <reserved> | <head> | <top> | <free-list> | <tick> |

module.exports = class Storage {
  constructor (file) {
    if (typeof file === 'string') file = raf(file)

    this.file = file
    this.header = null
    this.tick = 0
    this.head = 0
    this.size = 0
    this.top = 0
  }

  get (index, cb) {
    const self = this
    const offset = this.offset(index)

    this.file.read(offset, offset + MIN_SIZE > this.size ? this.size - offset : MIN_SIZE, function (err, data) {
      if (err) return cb(null, data)
      const id = data[0]
      if (id === 0) return cb(null, data)
      const blkSize = MIN_SIZE << id
      self.file.read(offset, offset + blkSize > self.size ? self.size - offset : blkSize, cb)
    })
  }

  offset (index) {
    return (index - 1) * MIN_SIZE + 4096
  }

  append (blk, cb) {
    const self = this
    const id = sizeId(blk.length)
    const ptr = 24 + id * 16
    const free = uint64be.decode(this.header, ptr)
    const isTop = !free
    const index = free || this.top || 1
    const offset = this.offset(index)

    blk[0] = id

    this.file.write(offset, blk, function (err) {
      if (err) return cb(err)

      if (isTop) return onfreeused(null, null)

      const prev = uint64be.decode(self.header, ptr + 8)
      if (!prev) return onfreeused(null, null)

      self.file.read(self.offset(prev), 10, onfreeused)

      function onfreeused (err, data) {
        if (err) return cb(err)

        self.head = index
        uint64be.encode(index, self.header, 8)

        if (isTop) {
          self.size = offset + blk.length
          self.top = index + (1 << id)
          uint64be.encode(self.top, self.header, 16)
        } else {
          const index = data ? uint64be.decode(data, 2) : 0
          uint64be.encode(prev, self.header, ptr)
          uint64be.encode(index, self.header, ptr + 8)
        }

        cb(null)
      }
    })
  }

  free (index, blkSize, cb) {
    const header = this.header
    const id = sizeId(blkSize)

    const ptr = 24 + id * 16
    const freed = Buffer.alloc(10)
    const prev = uint64be.decode(header, ptr)

    freed[0] = id
    freed[1] = 1 // freed
    uint64be.encode(prev, freed, 2)

    this.file.write(this.offset(index), freed, function (err) {
      if (err) return cb(err)

      uint64be.encode(index, header, ptr)
      uint64be.encode(prev, header, ptr + 8)
      cb(null)
    })
  }

  writeHeader (cb) {
    const self = this

    const tick = (this.tick + 1) & 255
    const offset = (tick & 1) * 2048

    this.header[536] = tick
    this.file.write(offset, this.header, function (err) {
      if (!err) return cb(null)
      self.tick = tick
      cb(err)
    })
  }

  open (cb) {
    const self = this

    this.file.read(2048, 537, function (_, a) {
      self.file.read(0, 537, function (err, b) {
        if (err) return onheader(Buffer.alloc(537))
        if (!a) return onheader(b)

        const aDist = (a[536] - b[536]) & 255
        const bDist = (b[536] - a[536]) & 255

        if (aDist < bDist) onheader(a)
        else onheader(b)
      })
    })

    function onheader (header) {
      self.tick = header[536]
      self.header = header
      self.head = uint64be.decode(header, 8)
      self.top = uint64be.decode(header, 16)

      self.file.stat(function (_, st) {
        if (st) self.size = st.size
        cb(null)
      })
    }
  }
}

function sizeId (blockSize) {
  const zeros = Math.clz32((blockSize - 1) >> MIN_BITS)
  return zeros === 32 ? 0 : 31 - zeros
}