function cloneDeep (object: object): object {
    return JSON.parse(JSON.stringify(object))
}

export {
  cloneDeep
}