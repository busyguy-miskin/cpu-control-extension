// indicator.js — CPU 控制器顶栏 indicator
//
// 架构:
//   PanelMenu.Button 子类 → 顶栏显示 🔒 2.9G 65°
//   下拉菜单 → 两层控制 (均通过 pkexec 提权, 与 lock/unlock 一致):
//     第 1 层 (sysfs):  锁定/解锁 boost
//     第 2 层 (ryzenadj): 调优档位 (节能/均衡/性能/关闭)
//   定时刷新 → 每 2s 读 /sys + /run/ryzenadj-tune.status, 每 30s 读 journalctl (MCE)
//
// 注: 锁定/解锁按钮的 hover 高亮在鼠标移出后偶有残留, 这是 GNOME 46 +
//     Clutter 在该 widget 组合下的已知 quirk, 不影响功能。

import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

const HELPER = '/usr/libexec/cpuctrl';   // pkexec 调用的 root helper 路径
const TUNE_STATUS = '/run/ryzenadj-tune.status';  // 守护进程写出的 ryzenadj 状态
const FREQ_REFRESH_MS = 2000;             // 温度/频率/调优刷新间隔
const MCE_REFRESH_MS = 30000;             // MCE 计数刷新间隔

// ============================================================
// 读取函数: 全部同步读 /sys 或子进程, 返回值或 null
// ============================================================

function readSys(path) {
    try {
        const [, contents] = Gio.File.new_for_path(path).load_contents(null);
        return new TextDecoder().decode(contents).trim();
    } catch (e) {
        return null;
    }
}

// 读 k10temp 温度(CPU 核温)。遍历 hwmon 找 name==k10temp 的那颗
function readCpuTemp() {
    for (let i = 0; i < 16; i++) {
        const name = readSys(`/sys/class/hwmon/hwmon${i}/name`);
        if (name === 'k10temp') {
            const t = readSys(`/sys/class/hwmon/hwmon${i}/temp1_input`);
            if (t) return Math.round(parseInt(t, 10) / 1000);
        }
    }
    return null;
}

// 读 boost 状态('0'=锁定, '1'=解锁)
function readBoost() {
    return readSys('/sys/devices/system/cpu/cpufreq/boost');
}

// 读当前 CPU 频率(cpu0 代表值), 返回 MHz
function readFreq() {
    const f = readSys('/sys/devices/system/cpu/cpu0/cpufreq/scaling_cur_freq');
    return f ? Math.round(parseInt(f, 10) / 1000) : null;
}

// 异步读 MCE 计数(用 journalctl, adm 组用户可读)
//
// 必须用 communicate_utf8_async, 不能用 wait_check_async + communicate 两步。
// 后者是"先等进程退出, 再排空 stdout 管道"的顺序; 当 journalctl 输出
// 超过 Linux 管道缓冲(64 KB)时, 子进程会写满管道阻塞在 write, 永不退出,
// 于是 wait_check 的回调永不触发 → MCE 计数永远卡在初始值 0 (本机实测输出 ~150 KB,
// 必中)。communicate_utf8_async 在等待退出的同时并发排空管道, 不会死锁。
function readMceCountAsync(cb) {
    try {
        const proc = Gio.Subprocess.new(
            ['journalctl', '-k', '-b', '0', '--no-pager'],
            Gio.SubprocessFlags.STDOUT_PIPE);
        proc.communicate_utf8_async(null, null, (proc, res) => {
            try {
                const [, stdout] = proc.communicate_utf8_finish(res);
                cb((stdout.match(/Machine check events logged/g) || []).length);
            } catch (e) {
                cb(0);
            }
        });
    } catch (e) {
        cb(0);
    }
}

// 读 ryzenadj-tune.service 是否正在运行(active)
function readTuneActive() {
    try {
        const [, stdout] = GLib.spawn_command_line_sync(
            'systemctl is-active ryzenadj-tune.service');
        return new TextDecoder().decode(stdout).trim() === 'active';
    } catch (e) {
        return false;
    }
}

// 读守护进程写出的 ryzenadj 状态文件, 解析两组 LIMIT/VALUE。
// 文件是 `ryzenadj -i` 的输出(PM table), 格式如:
//   | PPT LIMIT FAST | 45.000 | fast-limit |
//   | PPT VALUE FAST | 17.123 |            |
//   | THM LIMIT CORE | 90.000 | ...        |
//   | THM VALUE CORE | 72.000 |            |
// 只取温度墙 + 功耗两组 (电流 EDC 不调, 见 cpuctrl TUNE_ARGS)。
// 返回 {tempLimit, tempVal, fastLimit, fastVal} 或 null
function readRyzenStatus() {
    const raw = readSys(TUNE_STATUS);
    if (!raw) return null;
    const result = {};
    // 匹配 "| NAME | value |" 行, 提取 NAME 和 value
    for (const line of raw.split('\n')) {
        const m = line.match(/^\|\s*(.+?)\s*\|\s*([\d.]+)\s*\|/);
        if (!m) continue;
        const name = m[1].trim();
        const val = parseFloat(m[2]);
        switch (name) {
            case 'THM LIMIT CORE': result.tempLimit = val; break;
            case 'THM VALUE CORE': result.tempVal = val; break;
            case 'PPT LIMIT FAST': result.fastLimit = val; break;
            case 'PPT VALUE FAST': result.fastVal = val; break;
        }
    }
    // 至少有温度墙才算有效
    return result.tempLimit !== undefined ? result : null;
}

// ============================================================
// 格式化
// ============================================================

// 顶栏紧凑格式: 2900 → "2.9G", 1400 → "1400M"
function formatFreqCompact(freqMHz) {
    if (freqMHz === null) return '?';
    return freqMHz >= 1000
        ? (freqMHz / 1000).toFixed(1) + 'G'
        : freqMHz + 'M';
}

// 菜单完整格式: 2900 → "2.90 GHz"
function formatFreqFull(freqMHz) {
    if (freqMHz === null) return '?';
    return freqMHz >= 1000
        ? (freqMHz / 1000).toFixed(2) + ' GHz'
        : freqMHz + ' MHz';
}

// 统一的限值/实测格式 (null 安全, 实测四舍五入)
// 95,72,'°C' → "95/72°C"   55,17,'W' → "55/17W"
function formatLimitVal(limit, val, unit) {
    const l = limit != null ? limit : '?';
    const v = val != null ? Math.round(val) : '?';
    return `${l}/${v}${unit}`;
}

// ============================================================
// pkexec 提权调用 helper
// ============================================================

// args 是传给 helper 的参数数组, 如 ['lock'] 或 ['tune', 'eco']
function callHelper(args) {
    try {
        const proc = Gio.Subprocess.new(
            ['pkexec', HELPER, ...args],
            Gio.SubprocessFlags.NONE);
        proc.wait_check_async(null, (proc, res) => {
            try {
                proc.wait_check_finish(res);
            } catch (e) {
                log(`[cpu-control] pkexec ${args.join(' ')} 失败或取消: ${e.message}`);
            }
        });
    } catch (e) {
        log(`[cpu-control] 启动 pkexec 失败: ${e.message}`);
    }
}

// ============================================================
// Indicator 类
// ============================================================

export const CpuIndicator = GObject.registerClass(
    class CpuIndicator extends PanelMenu.Button {
        _init() {
            super._init(0.5, 'CPU Boost 控制');

            // 顶栏布局: 🔒 2.9G 65°
            this._box = new St.BoxLayout({style_class: 'panel-status-menu-box'});
            this._lockIcon = new St.Label({
                text: '🔒',
                style_class: 'cpuctrl-lock',
                y_align: Clutter.ActorAlign.CENTER,
            });
            this._freqLabel = new St.Label({
                text: '?',
                style_class: 'cpuctrl-freq',
                y_align: Clutter.ActorAlign.CENTER,
            });
            this._tempLabel = new St.Label({
                text: '—°',
                style_class: 'cpuctrl-temp',
                y_align: Clutter.ActorAlign.CENTER,
            });
            this._box.add_child(this._lockIcon);
            this._box.add_child(this._freqLabel);
            this._box.add_child(this._tempLabel);
            this.add_child(this._box);

            // 状态缓存
            this._mceCount = 0;
            this._locked = true;
            // 实时读数缓存: 供菜单状态行复用, 保证与顶栏同源同节奏
            this._cpuTemp = null;
            this._freq = null;

            // 构建菜单
            this._buildMenu();

            // 打开菜单时强制刷新状态行文字 → 再打开看到的一定是最新值
            // (解决"点完操作后状态显示滞后"的体验问题)
            this._menuOpenId = this.menu.connect('open-state-changed', (menu, open) => {
                if (open) this._refreshMenuItems();
            });

            // 启动定时器(2s 刷新温度/频率/boost, 30s 刷新 MCE)
            this._freqTimer = GLib.timeout_add(
                GLib.PRIORITY_DEFAULT, FREQ_REFRESH_MS,
                () => { this._refreshFast(); return GLib.SOURCE_CONTINUE; });
            this._mceTimer = GLib.timeout_add(
                GLib.PRIORITY_DEFAULT, MCE_REFRESH_MS,
                () => { this._refreshMce(); return GLib.SOURCE_CONTINUE; });

            // 首次立即刷新
            this._refreshFast();
            this._refreshMce();
        }

        // ---------- 菜单构建 ----------

        _buildMenu() {
            this.menu.removeAll();
            this._locked = readBoost() === '0';

            // ===== 顶部: 全部状态展示(只读, 不可点击) =====
            this._statusFreq = this._makeStatusItem(
                `频率: ${formatFreqFull(readFreq())}`);
            this.menu.addMenuItem(this._statusFreq);

            this._statusBoost = this._makeStatusItem(
                `Boost: ${this._locked ? '🔒 已锁定' : '🔓 已解锁'} (MCE: ${this._mceCount})`);
            this.menu.addMenuItem(this._statusBoost);

            this._statusTune = this._makeStatusItem('调优: 读取中…');
            this.menu.addMenuItem(this._statusTune);
            this._statusTuneDetail = this._makeStatusItem('—');
            this.menu.addMenuItem(this._statusTuneDetail);

            this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

            // ===== Boost 控制(子菜单) =====
            const boostSub = new PopupMenu.PopupSubMenuMenuItem('Boost 控制');
            this._addActionTo(boostSub.menu, '🔒 锁定 boost (稳定模式)', ['lock']);
            this._addActionTo(boostSub.menu, '🔓 解锁 boost (性能模式)', ['unlock']);
            this.menu.addMenuItem(boostSub);

            // ===== 调优档位(子菜单) =====
            const tuneSub = new PopupMenu.PopupSubMenuMenuItem('调优档位');
            this._addActionTo(tuneSub.menu, '🟢 节能 (80°C / 38W)', ['tune', 'eco']);
            this._addActionTo(tuneSub.menu, '⚖️ 均衡 (90°C / 45W)', ['tune', 'balance']);
            this._addActionTo(tuneSub.menu, '🚀 性能 (95°C / 55W)', ['tune', 'performance']);
            this._addActionTo(tuneSub.menu, '⏹️ 关闭调优 (回出厂)', ['tune', 'off']);
            this.menu.addMenuItem(tuneSub);
        }

        // 纯展示菜单项
        _makeStatusItem(text) {
            const item = new PopupMenu.PopupBaseMenuItem({
                reactive: false,
                can_focus: false,
            });
            const label = new St.Label({text});
            item.add_child(label);
            item.label = label;  // 保留引用以便后续更新文字
            return item;
        }

        // 可点击操作按钮, 添加到指定 menu(主菜单或子菜单)。
        // args 是传给 callHelper 的参数数组
        _addActionTo(menu, labelText, args) {
            const item = new PopupMenu.PopupMenuItem(labelText);
            item.connect('activate', () => {
                callHelper(args);
                this.menu.close(true);
                // pkexec 异步执行, 耗时不确定(输密码、systemctl 操作)。
                // 单次刷新可能撞在"还没写完"的瞬间读到旧值 → 显示滞后。
                // 多次错峰刷新覆盖慢场景: 1s 快速反馈, 2.5s 覆盖常规, 5s 兜底。
                [1000, 2500, 5000].forEach(delay => {
                    GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
                        this._refreshFast();
                        return GLib.SOURCE_REMOVE;
                    });
                });
            });
            menu.addMenuItem(item);
        }

        // ---------- 刷新 ----------

        // 刷新菜单状态行文字(频率/boost/调优)。可被两个场景调用:
        //   - 定时器每个 tick (含菜单打开期间): 温度/频率持续更新, 与顶栏同源同节奏
        //   - 打开菜单瞬间: open-state-changed 信号触发, 不必等下一个 tick
        // 不再收 freq 参数: 频率/温度都从 _refreshFast 缓存的实例状态读取,
        // 避免 open-state-changed 不带参数时 formatFreqFull(undefined) 渲染成 "undefined MHz"
        _refreshMenuItems() {
            if (this._statusBoost) {
                this._statusBoost.label.text =
                    `Boost: ${this._locked ? '🔒 已锁定' : '🔓 已解锁'} (MCE: ${this._mceCount})`;
            }
            if (this._statusFreq) {
                this._statusFreq.label.text = `频率: ${formatFreqFull(this._freq)}`;
            }
            this._updateTuneStatus();
        }

        // 快速刷新: 顶栏显示(温度/频率/boost) + 调优状态行
        _refreshFast() {
            const temp = readCpuTemp();
            const freq = readFreq();
            this._locked = readBoost() === '0';

            // 缓存实时读数, 供菜单状态行复用 (温度墙实测值也用这个, 保证与顶栏同源)
            this._cpuTemp = temp;
            this._freq = freq;

            // 更新顶栏(随时刷新)
            this._tempLabel.text = temp !== null ? `${temp}°` : '—°';
            this._lockIcon.text = this._locked ? '🔒' : '🔓';
            this._freqLabel.text = formatFreqCompact(freq);

            // 菜单项文字每个 tick 都刷新 (含打开期间), 让菜单内温度与顶栏一致;
            // 打开瞬间的首刷由 open-state-changed 信号额外触发一次
            this._refreshMenuItems();
        }

        // 刷新第 2 层调优状态行(读守护进程写出的 status 文件)
        _updateTuneStatus() {
            if (!this._statusTune || !this._statusTuneDetail) return;

            const active = readTuneActive();
            if (!active) {
                this._statusTune.label.text = '调优: ⏹️ 未运行 (出厂设置)';
                this._statusTuneDetail.label.text = '点下方档位开启调优';
                return;
            }

            const r = readRyzenStatus();
            if (!r) {
                this._statusTune.label.text = '调优: ✅ 运行中 (读取中…)';
                this._statusTuneDetail.label.text = '—';
                return;
            }

            this._statusTune.label.text = '调优: ✅ 运行中';
            // 详情: 温度墙 + 功耗, 统一用 "限值/实测" 格式 (限值在前, 斜杠分隔, 单位各自尾随)
            // - 温度墙限值取 ryzenadj 的 tctl-temp; 实测温度用 k10temp 实时核温 (this._cpuTemp),
            //   与顶栏同源同节奏, 避免菜单里显示另一颗 SMU 传感器导致两边温度不一致
            // - 功耗限值/实测都取 ryzenadj SMU 的 PPT FAST
            const tempStr = formatLimitVal(r.tempLimit, this._cpuTemp, '°C');
            const fastStr = formatLimitVal(r.fastLimit, r.fastVal, 'W');
            this._statusTuneDetail.label.text =
                `温度墙 ${tempStr}  ·  功耗 ${fastStr}`;
        }

        // 慢速刷新: MCE 计数
        _refreshMce() {
            readMceCountAsync((count) => {
                this._mceCount = count;
                // 直接走统一的菜单刷新 (内部已判空), 打开菜单时也更新
                this._refreshMenuItems();
            });
        }

        // ---------- 清理 ----------

        destroy() {
            if (this._freqTimer) {
                GLib.source_remove(this._freqTimer);
                this._freqTimer = null;
            }
            if (this._mceTimer) {
                GLib.source_remove(this._mceTimer);
                this._mceTimer = null;
            }
            if (this._menuOpenId) {
                this.menu.disconnect(this._menuOpenId);
                this._menuOpenId = null;
            }
            super.destroy();
        }
    }
);
