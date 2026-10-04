/* M8 MotionManager - port of tv/bilibili/script/MotionManager.as
 * motion/motionGroup system: normalize props -> group by
 * (lifeTime,startDelay,easing,repeat) -> BetweenAS3 tween tree; expiry removes element
 */
(function (global) {
  "use strict";
  const M8 = global.M8RE;
  const BetweenAS3 = M8.BetweenAS3;
  const Easing = M8.Easing;
  const TweenEvent = M8.TweenEvent;
  const getTimer = M8.getTimer;

  const EASING_MAP = {
    "None": null,
    "Linear": Easing.Linear,
    "Sine": Easing.Sine,
    "Back": Easing.Back,
    "Bounce": Easing.Bounce,
    "Circular": Easing.Circular,
    "Circ": Easing.Circ,
    "Cubic": Easing.Cubic,
    "Elastic": Easing.Elastic,
    "Exponential": Easing.Exponential,
    "Expo": Easing.Expo,
    "Quadratic": Easing.Quadratic,
    "Quad": Easing.Quad,
    "Quartic": Easing.Quartic,
    "Quart": Easing.Quart,
    "Quintic": Easing.Quintic,
    "Quint": Easing.Quint
  };

  class MotionManager {
    constructor(target) {
      this.acceptValue = ["x", "y", "alpha", "rotationZ", "rotationY", "rotationX", "fontsize"];
      this._$tmv = null;
      this._$tmr = null;
      this._$MotionConfig = {};
      this._$CompleteCallBack = null;
      this._$target = target;
      this.optimizedGroup = [];
      this.isRelative = false;
      this.motionComplete = false;
      this.motionPlayTime = 0;
      this._$internalTimer = 0;
      this._$internalRun = 0;
      this._$running = false;
      this._efBound = null;
    }

    get running() {
      return this._$running;
    }

    _onEnterFrame() {
      if (this._$internalRun + getTimer() - this._$internalTimer > this._$MotionConfig.lifeTime * 1000) {
        if (this._efBound) this._$target.removeEventListener("enterFrame", this._efBound);
        this.stop();
        if (this._$CompleteCallBack != null) {
          this._$CompleteCallBack(null);
        }
      }
    }

    reset() {
      this.stop();
      if (this._$tmv) this._$tmv.gotoAndStop(0);
      this.motionComplete = false;
    }

    play() {
      if (this._$running) return;
      if (this.isRelative) {
        this.updateTween();
      }
      if (!this._$running && this._$MotionConfig.lifeTime > 0) {
        this._$internalTimer = getTimer();
        if (!this._efBound) {
          this._efBound = this._onEnterFrame.bind(this);
          this._$target.addEventListener("enterFrame", this._efBound);
        }
      }
      this._$running = true;
      if (!this.motionComplete && this._$tmv) {
        this._$tmv.play();
      }
    }

    stop() {
      if (!this._$running) return;
      if (this._$tmv) {
        this._$tmv.stop();
      }
      if (this._$running) {
        if (this._$MotionConfig.lifeTime > 0) {
          this._$internalRun += getTimer() - this._$internalTimer;
          if (this._efBound) this._$target.removeEventListener("enterFrame", this._efBound);
        }
        this._$running = false;
      }
    }

    forcasting(t) {
      if (this._$MotionConfig.lifeTime == 0 && t > this.motionPlayTime) {
        return true;
      }
      if (this._$MotionConfig.lifeTime == 0) {
        return false;
      }
      if (t > this.motionPlayTime && t < this.motionPlayTime + this._$MotionConfig.lifeTime * 1000) {
        return true;
      }
      return false;
    }

    setPlayTime(t) {
      this.motionPlayTime = t;
    }

    updateTween() {
      const tmvList = [];
      const serials = [];
      for (const optimizedGroupItem of this.optimizedGroup) {
        for (const subKey in optimizedGroupItem) {
          const cfg_grp = optimizedGroupItem[subKey];
          const fromValue = {};
          const toValue = {};
          let lifeTime = 0;
          let startDelay = 0;
          let repeat = 1;
          let s_easing = "Sine";
          for (const cfg of cfg_grp) {
            if (!lifeTime) {
              lifeTime = Number(cfg.lifeTime);
              startDelay = Number(cfg.startDelay);
              s_easing = cfg.easing;
              repeat = Number(cfg.repeat);
            }
            if (this.isRelative) {
              // legacy quirk: relative x AND y both scale by parent.width
              if (cfg.key == "x" || cfg.key == "y") {
                const pw = this._$target.parent ? this._$target.parent.width : 0;
                if (cfg.fromValue > 0 && cfg.fromValue < 1) {
                  cfg.fromValue = pw * cfg.fromValue;
                }
                if (cfg.toValue > 0 && cfg.toValue < 1) {
                  cfg.toValue = pw * cfg.toValue;
                }
              }
            }
            fromValue[cfg.key] = cfg.fromValue;
            toValue[cfg.key] = cfg.toValue;
          }
          let t_easing;
          switch (s_easing) {
            case "None": t_easing = null; break;
            case "Back": t_easing = Easing.Back.easeInOut; break;
            case "Bounce": t_easing = Easing.Bounce.easeInOut; break;
            case "Circular": t_easing = Easing.Circular.easeInOut; break;
            case "Circ": t_easing = Easing.Circ.easeInOut; break;
            case "Cubic": t_easing = Easing.Cubic.easeInOut; break;
            case "Elastic": t_easing = Easing.Elastic.easeInOut; break;
            case "Exponential": t_easing = Easing.Exponential.easeInOut; break;
            case "Expo": t_easing = Easing.Expo.easeInOut; break;
            case "Sine": t_easing = Easing.Sine.easeInOut; break;
            case "Quintic": t_easing = Easing.Quintic.easeInOut; break;
            case "Quint": t_easing = Easing.Quint.easeInOut; break;
            case "Linear": t_easing = Easing.Linear.easeInOut; break;
            default: t_easing = Easing.Sine.easeInOut;
          }
          let tmv = BetweenAS3.tween(this._$target, toValue, fromValue, lifeTime, t_easing);
          if (startDelay) {
            tmv = BetweenAS3.delay(tmv, startDelay / 1000);
          }
          if (repeat > 1) {
            tmv = BetweenAS3.repeat(tmv, repeat);
          }
          const self = this;
          const tmv_f = function () {
            self.motionComplete = true;
            tmv.removeEventListener(TweenEvent.COMPLETE, tmv_f);
          };
          tmv.addEventListener(TweenEvent.COMPLETE, tmv_f);
          tmvList.push(tmv);
        }
        serials.push(BetweenAS3.parallelTweens(tmvList.slice()));
      }
      if (serials.length == 1) {
        this._$tmv = serials.pop();
      } else {
        // legacy (AS3 L265): multiple groups serialize a flat tmvList
        this._$tmv = BetweenAS3.serialTweens(tmvList);
      }
    }

    initTween(MotionConfig, motionGroup) {
      if (!motionGroup) {
        this.optimizedGroup.length = 0;
      }
      const mKey = this.optimizedGroup.length;
      this.optimizedGroup[mKey] = {};
      this.isRelative = false;
      if (MotionConfig.lifeTime === undefined) {
        MotionConfig.lifeTime = 3;
      }
      for (const key of this.acceptValue) {
        if (MotionConfig[key] !== undefined) {
          const mc = MotionConfig[key];
          if (!mc.lifeTime) {
            mc.lifeTime = MotionConfig.lifeTime;
          }
          if (mc.startDelay === undefined || mc.startDelay <= 0) {
            mc.startDelay = 0;
          }
          if (mc.toValue === undefined) {
            if (mc.fromValue === undefined) {
              return "Motion " + key + " error: no transform";
            }
            mc.toValue = mc.fromValue;
          }
          if (mc.easing === undefined) {
            mc.easing = "Linear";
          }
          if (mc.repeat === undefined) {
            mc.repeat = 1;
          }
          const subKey = String(mc.lifeTime) + "," + String(mc.startDelay) + "," + mc.easing + "," + mc.repeat;
          if (key == "x" || key == "y") {
            if ((mc.fromValue > 0 && mc.fromValue < 1) || (mc.toValue > 0 && mc.toValue < 1)) {
              this.isRelative = true;
            }
          }
          mc.key = key;
          if (this.optimizedGroup[mKey][subKey] === undefined) {
            this.optimizedGroup[mKey][subKey] = [];
          }
          this.optimizedGroup[mKey][subKey].push(mc);
        }
      }
      if (MotionConfig.lifeTime > 0 && !motionGroup) {
        this._$tmr = new M8.Timer(MotionConfig.lifeTime * 1000, 1);
        this._$tmr.stop();
        const self = this;
        const tmr_f = function () {
          if (self._$tmr) self._$tmr.removeEventListener("timerComplete", tmr_f);
          self._$tmr.stop();
          if (self._$tmv) self._$tmv.stop();
          if (self._$CompleteCallBack != null) {
            self._$CompleteCallBack(null);
          }
        };
        this._$tmr.addEventListener("timerComplete", tmr_f);
      } else if (!motionGroup) {
        this._$tmr = null;
      }
      this._$MotionConfig = MotionConfig;
      if (!this.isRelative) {
        this.updateTween();
      }
      return "";
    }

    initTweenGroup(group, lifeTime) {
      this.optimizedGroup.length = 0;
      for (const cfg of group) {
        if (lifeTime !== undefined && !isNaN(lifeTime)) {
          cfg.lifeTime = lifeTime;
        }
        const err = this.initTween(cfg, true);
        if (err) {
          throw new Error(err);
        }
      }
    }

    setCompleteListener(fn) {
      this._$CompleteCallBack = fn;
    }
  }
  M8.MotionManager = MotionManager;
})(typeof window !== 'undefined' ? window : globalThis);
