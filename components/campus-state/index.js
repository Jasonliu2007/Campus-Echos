Component({
  properties: {
    reducedMotion: Boolean,
    reducedTransparency: Boolean,
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
