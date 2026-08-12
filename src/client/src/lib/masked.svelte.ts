function createMasked() {
  let value = $state(false)
  return {
    get masked() {
      return value
    },
    toggle() {
      value = !value
    },
  }
}

export const maskedStore = createMasked()
