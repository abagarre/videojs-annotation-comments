/*
    Component for managing the state of annotations, including showing active annotation during playback,
    toggling active states for annotations, navigating annotations forward/back, etc
*/

const Utils = require('./../lib/utils');
const PlayerComponent = require('./../lib/player_component');
const Annotation = require('./annotation');

module.exports = class AnnotationState extends PlayerComponent {
  constructor(player) {
    super(player);
    this.initAPI(this, 'AnnotationState');
    this.resetData();
    this.bindEvents();
  }

  // sets _enabled and closes or opens annotation as needed
  set enabled(shouldBeEnabled) {
    this._enabled = shouldBeEnabled;
    if (!shouldBeEnabled) this.activeAnnotation.close();
    if (shouldBeEnabled) {
      this.skipLiveCheck = false;
      this.setLiveAnnotation();
    }
  }

  get enabled() {
    return this._enabled;
  }

  // Sets _annotations w/Annoation objects from input array
  set annotations(annotationsData) {
    this._annotations = annotationsData.map(a => new Annotation(a, this.player));
    this.sortAnnotations();
    this.rebuildAnnotationTimeMap();
  }

  get annotations() {
    return this._annotations;
  }

  set activeAnnotation(annotation) {
    this._activeAnnotation = annotation;
  }

  // Get current active annotation or a null object with .close()
  get activeAnnotation() {
    return this._activeAnnotation || { close: () => {} };
  }

  set activeAnnotationList(annotationList) {
    this._activeAnnotationList = annotationList;
  }

  get activeAnnotationList() {
    return this._activeAnnotationList || [];
  }

  // Serialize data
  get data() {
    return this._annotations.map(a => a.data);
  }

  // Bind events for setting liveAnnotation on video time change
  bindEvents() {
    this.player.on('timeupdate', Utils.throttle(this.setLiveAnnotation.bind(this), 100));
  }

  // Sort annotations by range.start
  sortAnnotations() {
    this._annotations.sort((a, b) => {
      return a.range.start < b.range.start ? -1 : a.range.start > b.range.start ? 1 : 0;
    });
  }

  // Add a new annotation
  addNewAnnotation(annotation) {
    this._annotations.push(annotation);
    this.openAnnotation(annotation, true, true, false, true);
    this.stateChanged(annotation.id);
    this.setLiveAnnotation();
  }

  // Add a new ext annotation
  addNewExtAnnotation(annotation) {
    this._annotations.push(annotation);
    this.rebuildAnnotationTimeMap();
  }

  // Create and add a annotation
  createAndAddAnnotation(data) {
    this.plugin.controls.uiState.adding && this.plugin.controls.cancelAddNew();

    const annotation = Annotation.newFromData(
      data.range,
      data.shape,
      data.commentStr || '',
      this.plugin,
      data.id || Utils.guid()
    );
    this.addNewAnnotation(annotation);
  }

  // Create and add ext annotation
  createAndAddExtAnnotation(data) {
    this.plugin.controls.uiState.adding && this.plugin.controls.cancelAddNew();

    const annotation = Annotation.newFromExtData(
      data.range,
      data.shape,
      data.comments,
      this.plugin,
      data.id);
    this.addNewExtAnnotation(annotation);
  }

  // Destroy an existing annotation
  destroyAnnotationById(id) {
    const annotation = this.findAnnotation(id);
    if (annotation) annotation.teardown();
  }

  // Destroy an existing annotation of another user
  destroyExtAnnotationById(id) {
    const annotation = this.findAnnotation(id);
    if (annotation) annotation.teardown(true, false);
  }

  // Remove an annotation
  removeAnnotation(annotation, fireEvent = true) {
    const { id } = annotation;
    const i = this._annotations.indexOf(annotation);
    this._annotations.splice(i, 1);
    if(fireEvent) {
      // this.stateChanged();
      this.plugin.fire('annotationDeleted', { id });
    }
    this.sortAnnotations();
    this.rebuildAnnotationTimeMap();
  }

  // Set the live annotation based on current video time
  setLiveAnnotation() {
    if (!this.enabled) return;
    const time = Math.floor(this.currentTime);

    if (this.skipLiveCheck) {
      if (time !== this.lastVideoTime) this.skipLiveCheck = false;
      return;
    }

    const matches = this.activeAnnotationsForTime(time);
    // if (!matches.length) return this.activeAnnotation.close();

    if (!matches.length) {
      this.annotations.forEach((ann) => {ann.close()});
      this.activeAnnotationList = [];
      return;
    }

    // close all annotations that just became inactive
    // update activeAnnotationList
    const _activeAnnotationList = [];
    this.activeAnnotationList.forEach((ann) => {
      if(ann.secondsActive.includes(time)) {
        _activeAnnotationList.push(ann);
      } else {
        ann.close();
      }
    });
    this.activeAnnotationList = [..._activeAnnotationList];

    const _this = this;
    // Open annotations that just became active
    matches.forEach((match) => {
      if(!_this.annotations[match].isOpen) {
        _this.openAnnotation(_this.annotations[match], false, false, true);
        if(!_this.activeAnnotationList.includes(_this.annotations[match])) {
          _this.activeAnnotationList.push(_this.annotations[match]);
        }
      }
    })

    /*
    // Set live annotation as the last match
    const liveAnnotation = this.annotations[matches[matches.length - 1]];

    // Special cases if this or another annotation is active
    if (this.activeAnnotation.range) {
      if (liveAnnotation === this.activeAnnotation) return;
      // Check if the active annotation and live annotation share a start time
      // Is that start time at the current playhead?
      // If so, don't switch which is active.
      const liveStart = liveAnnotation.range.start;
      const activeStart = this.activeAnnotation.range.start;
      if (liveStart === activeStart && liveStart === time) return;
    }

    this.openAnnotation(liveAnnotation, false, false, true);
     */
  }

  // Get all active annotations for a time (in seconds)
  activeAnnotationsForTime(time) {
    if (!this.annotations.length) return [];
    return this.annotationTimeMap[time] || [];
  }

  /*
        Rebuild the annotation time map
        Example: this._annotations[1] and this._annotations[3] are active during second 4
            this.annotationTimeMap = { 4: [1, 3] }
    */
  rebuildAnnotationTimeMap() {
    const timeMap = {};
    this.annotations.forEach(annotation => {
      annotation.secondsActive.forEach(second => {
        const val = timeMap[second] || [];
        val.push(this.annotations.indexOf(annotation));
        timeMap[second] = val;
      });
    });
    this.annotationTimeMap = timeMap;
  }

  // Close active annotation and remove reference in state
  clearActive() {
    // this.activeAnnotation.close(false);
    this.activeAnnotationList.forEach(ann => ann.close());
    this._activeAnnotation = null;
  }

  // Open annotation with options to pause and show preview
  // skipLiveCheck will short circuit setLiveAnnotation()
  openAnnotation(
    annotation,
    skipLiveCheck = false,
    pause = true,
    previewOnly = false,
    forceSnapToStart = false
  ) {
    if (!this.plugin.active) this.plugin.toggleAnnotationMode();
    this.skipLiveCheck = skipLiveCheck;
    // this.clearActive();
    annotation.open(pause, previewOnly, forceSnapToStart);
    // this.activeAnnotation = annotation;
    this.lastVideoTime = annotation.range.start;
  }

  // Open an annotation by ID (if it exists)
  openAnnotationById(id) {
    const annotation = this.findAnnotation(id);
    if (annotation) this.openAnnotation(annotation, true, false, false);
  }

  // Returns annotation object given ID
  findAnnotation(id) {
    return this.annotations.find(a => a.id == id);
  }

  // Returns comment object given ID
  findComment(id) {
    let comments = this.annotations.map(a => a.commentList.comments);
    comments = [].concat(...comments); // flatten 2d array
    return comments.find(c => c.id == id);
  }

  // Finds the next annotation in collection and opens it
  nextAnnotation() {
    if (this._activeAnnotation) {
      const ind = this.annotations.indexOf(this._activeAnnotation);
      const nextInd = ind === this.annotations.length - 1 ? 0 : ind + 1;
      return this.openAnnotation(this.annotations[nextInd], true);
    }
    const time = Math.floor(this.currentTime);
    for (let i = 0; i < this.annotations.length; i++) {
      if (this.annotations[i].range.start > time)
        return this.openAnnotation(this.annotations[i], true);
    }
    this.openAnnotation(this.annotations[0], true);
  }

  // Finds the previous annotation in collection and opens it
  prevAnnotation() {
    if (this._activeAnnotation) {
      const ind = this.annotations.indexOf(this._activeAnnotation);
      const nextInd = ind === 0 ? this.annotations.length - 1 : ind - 1;
      return this.openAnnotation(this.annotations[nextInd], true);
    }
    const time = Math.floor(this.currentTime);
    for (let i = this.annotations.length - 1; i >= 0; i--) {
      if (this.annotations[i].range.start < time)
        return this.openAnnotation(this.annotations[i], true);
    }
    this.openAnnotation(this.annotations[this.annotations.length - 1], true);
  }

  // Use anywhere the annotation data changes
  // Cleans internal state data, updates player button, triggers configurable callback
  stateChanged(id = null) {
    this.sortAnnotations();
    this.rebuildAnnotationTimeMap();
    if(id != null) {
      const data = {};
      data.data = this.data;
      data.id = id;
      this.plugin.fire('onStateChanged', data);
    } else {
      this.plugin.fire('onStateChanged', this.data);
    }
  }

  // Reset internal state properties
  resetData() {
    this.annotations = [];
    this.annotationTimeMap = {};
    this.activeAnnotation = null;
    this.activeAnnotationList = [];
    this.enabled = false;
    this.skipNextTimeCheck = false;
    this.lastVideoTime = 0;
  }

  // Remove UI and unbind events for this and child components
  teardown() {
    this.annotations.forEach(annotation => {
      annotation.teardown(false);
    });
    this.resetData();
    super.teardown();
  }
};
