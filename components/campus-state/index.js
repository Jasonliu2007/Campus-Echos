Component({
  properties: {
    kind: {
      type: String,
      value: 'empty'
    },
    title: String,
    description: String,
    action: String
  },
  methods: {
    onAction() {
      this.triggerEvent('action')
    }
  }
});
