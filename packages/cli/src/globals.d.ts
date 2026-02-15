declare global {
  interface Body {
    json(): Promise<any>
  }
}

export {}
