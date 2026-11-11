Component({
  properties: {
    post: Object,
    showStatus: Boolean,
    reducedMotion: Boolean
  },
  methods: {
    open() {
      this.triggerEvent('open', {
        id: this.data.post._id
      })
    }
  }
});
