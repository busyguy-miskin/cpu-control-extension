// extension.js — GNOME Shell 46 入口
// 作用: 注册 indicator 到顶栏, 管理 enable/disable 生命周期
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {CpuIndicator} from './indicator.js';

export default class CpuControlExtension extends Extension {
    enable() {
        this._indicator = new CpuIndicator();
        // addToStatusArea(uuid, indicator, position) — 默认加到顶栏右侧
        Main.panel.addToStatusArea(this.uuid, this._indicator);
    }

    disable() {
        // GNOME 严格要求 disable() 清理所有资源(信号/timeout/actor)
        if (this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }
    }
}
