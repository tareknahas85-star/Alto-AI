// Decodes the emulator's raw H.264 stream (Annex B) with WebCodecs and draws it on a canvas.
// The stream has no container, so this splits it into access units (one picture each).

const START_CODE = [0x00, 0x00, 0x01]

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.length === 0) return b
  const out = new Uint8Array(a.length + b.length)
  out.set(a, 0)
  out.set(b, a.length)
  return out
}

const hex = (n: number): string => n.toString(16).padStart(2, '0')

export class H264Player {
  private decoder: VideoDecoder | null = null
  private ctx: CanvasRenderingContext2D | null
  private buf: Uint8Array = new Uint8Array(0)
  private au: Uint8Array[] = []
  private auHasPicture = false
  private auKey = false
  private codec = ''
  private configuredCodec = ''
  private timestamp = 0
  private started = false // a key frame has been sent; deltas before it cannot be decoded

  constructor(private canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')
    this.createDecoder()
  }

  private createDecoder(): void {
    if (typeof VideoDecoder === 'undefined') return
    this.decoder = new VideoDecoder({
      output: (frame) => this.draw(frame),
      error: () => this.recover()
    })
  }

  // A decoder error closes it for good: start a fresh one and wait for the next key frame.
  private recover(): void {
    this.configuredCodec = ''
    this.started = false
    this.au = []
    this.auHasPicture = false
    this.auKey = false
    this.timestamp = 0
    try {
      this.decoder?.close()
    } catch {
      // already closed
    }
    this.createDecoder()
    this.configure()
  }

  get supported(): boolean {
    return this.decoder !== null
  }

  push(data: Uint8Array): void {
    if (!this.decoder) return
    this.buf = concat(this.buf, data)
    const starts: number[] = []
    const b = this.buf
    for (let i = 0; i + 2 < b.length; i++) {
      if (b[i] === START_CODE[0] && b[i + 1] === START_CODE[1] && b[i + 2] === START_CODE[2]) {
        starts.push(i)
        i += 2
      }
    }
    if (starts.length < 2) return // the last NAL is complete only once the next start code arrives
    for (let k = 0; k < starts.length - 1; k++) {
      const begin = starts[k] + 3
      let end = starts[k + 1]
      if (end > begin && b[end - 1] === 0) end-- // zero_byte of a 4-byte start code
      if (end > begin) this.onNal(b.subarray(begin, end))
    }
    this.buf = b.slice(starts[starts.length - 1])
  }

  private onNal(nal: Uint8Array): void {
    const type = nal[0] & 0x1f
    if (type === 9) {
      this.flush() // access unit delimiter: a new picture starts after it
      return
    }
    if (type === 1 || type === 5) {
      // first_mb_in_slice == 0 is coded as a leading 1 bit: that starts a new picture
      const newPicture = (nal[1] & 0x80) !== 0
      if (this.auHasPicture && newPicture) this.flush()
      this.auHasPicture = true
      if (type === 5) this.auKey = true
    } else if ((type === 6 || type === 7 || type === 8) && this.auHasPicture) {
      this.flush()
    }
    if (type === 7 && nal.length >= 4) {
      this.codec = `avc1.${hex(nal[1])}${hex(nal[2])}${hex(nal[3])}`
      this.configure()
    }
    const framed = new Uint8Array(nal.length + 4)
    framed.set([0, 0, 0, 1], 0)
    framed.set(nal, 4)
    this.au.push(framed)
  }

  private configure(): void {
    if (!this.decoder || !this.codec || this.codec === this.configuredCodec) return
    this.decoder.configure({ codec: this.codec, optimizeForLatency: true })
    this.configuredCodec = this.codec
  }

  private flush(): void {
    if (!this.decoder || !this.auHasPicture || this.au.length === 0) {
      this.au = []
      this.auHasPicture = false
      this.auKey = false
      return
    }
    const size = this.au.reduce((n, p) => n + p.length, 0)
    const data = new Uint8Array(size)
    let off = 0
    for (const p of this.au) {
      data.set(p, off)
      off += p.length
    }
    const key = this.auKey
    this.au = []
    this.auHasPicture = false
    this.auKey = false
    if (this.decoder.state !== 'configured') return // nothing to decode until the first SPS
    if (key) this.started = true
    if (!this.started) return
    this.decoder.decode(
      new EncodedVideoChunk({ type: key ? 'key' : 'delta', timestamp: this.timestamp, data })
    )
    this.timestamp += 33333
  }

  private draw(frame: VideoFrame): void {
    if (this.canvas.width !== frame.displayWidth || this.canvas.height !== frame.displayHeight) {
      this.canvas.width = frame.displayWidth
      this.canvas.height = frame.displayHeight
    }
    this.ctx?.drawImage(frame, 0, 0)
    frame.close()
  }

  close(): void {
    try {
      this.decoder?.close()
    } catch {
      // already closed
    }
    this.decoder = null
    this.buf = new Uint8Array(0)
    this.au = []
  }
}
