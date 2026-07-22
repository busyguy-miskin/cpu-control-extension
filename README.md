# CPU 控制 — GNOME 扩展(双层:boost 锁 + ryzenadj 调优)

为 AMD Ryzen 7 4800H 笔记本(ASUS TUF A15 FA506IV)设计,解决 L3 缓存电压不稳导致的 MCE(Machine Check Exception)和系统死机。

## 双层架构

两层各司其职,扩展菜单统一控制,都走 polkit 弹窗提权(非 NOPASSWD):

```
┌─ 第 1 层 (sysfs): boost 锁 ─────────────────────────┐
│  boost=0 + 锁频率 2.9GHz                              │
│  → 根治 L3 缓存 MCE (ryzenadj 无法替代的能力)          │
│  → 由 cpu-boost-lock.service 开机自启                  │
└──────────────────────────────────────────────────────┘
┌─ 第 2 层 (ryzenadj): 调优 ──────────────────────────┐
│  收紧 温度墙 / 瞬时功耗 (不碰电流, 避免欠流不稳)       │
│  → 降低电压波动幅度, 给 L3 缺陷更多安全余量            │
│  → 由 ryzenadj-tune.service 守护 (30s 重应用)         │
└──────────────────────────────────────────────────────┘
```

**为什么需要两层:** `boost=0`(关睿频)是 sysfs 独占能力,ryzenadj 没有等价开关;ryzenadj 调的是 SMU 层功耗/温度,sysfs 管不了。两者正交,缺一不可。

**为什么不调电流(EDC):** 电流限太低会在重负载时触发欠流,反而引发不稳。本扩展只收紧温度墙和功耗,把电流交给出厂默认。

**为什么第 2 层需要守护进程:** ryzenadj 设置是易失的——SMU 重置、挂起恢复、固件电源管理都会覆盖它。守护进程每 30 秒重新应用(参考官方 `readjust.py`)。

## 预设档位(扩展菜单)

| 档位 | 温度墙 (°C) | 瞬时功耗 PPT FAST (W) | 定位 |
|---|---|---|---|
| 🟢 节能 | 80 | 38 | 最凉,负载限频明显,适合轻办公/续航 |
| ⚖️ 均衡 | 90 | 45 | 日常默认 |
| 🚀 性能 | 95 | 55 | 接近出厂略收紧,重负载余量足 |
| ⏹️ 关闭调优 | — | — | 停守护进程,回出厂 95°C/60W |

三档均与 boost 锁层正交(boost 归 `lock`/`unlock` 管)。ryzenadj 参数单位:功率 mW、温度 °C。

## 顶栏与菜单

**顶栏实时显示**:`🔒 2.9G 65°`(锁定状态 + 频率 + 温度)

**下拉菜单**:
- 频率(实时)
- Boost 状态 + MCE 计数
- 自启锁定 service 状态
- 调优状态(档位 + 温度墙/功耗的 限制值/实测值 + 守护状态)
- 🔒 **锁定 boost** / 🔓 **解锁 boost**(第 1 层)
- 🟢 **节能** / ⚖️ **均衡** / 🚀 **性能** / ⏹️ **关闭调优**(第 2 层)

所有操作通过 **polkit 提权**(GNOME 原生密码框),`auth_admin_keep`:输一次密码 5 分钟内免重复弹窗。

## 背景

4800H(Zen2)存在硬件级缺陷:高负载→低负载切换时,电压下调速度快于频率下降,导致 L3 缓存在低频低压区出现 MCE,累积触发系统死锁。

实测验证:`boost=0`(关闭睿频)+ 锁频率 2.9GHz 能彻底消除 MCE;叠加 ryzenadj 收紧温度/功耗可进一步降低电压波动。本扩展把这套方案做成顶栏一键控制。

## 文件结构

```
cpu-control-extension/
├── README.md                       ← 本文件
├── install.sh                      ← 统一安装/卸载脚本
├── extension/                      ← GNOME 扩展(用户级)
│   ├── metadata.json
│   ├── extension.js                 (入口 enable/disable)
│   ├── indicator.js                 (顶栏 + 菜单 + 两层控制 + 定时刷新)
│   └── stylesheet.css
└── system/                         ← 系统级文件(需 root)
    ├── cpuctrl                      (/usr/libexec/cpuctrl, root helper)
    │                                 lock|unlock|tune eco|balance|performance|off|status
    ├── org.miskin.cpuctrl.policy    (polkit 策略)
    ├── ryzenadj-tune                (/usr/libexec/ryzenadj-tune, 调优守护脚本)
    ├── ryzenadj-tune.service        (ryzenadj 调优 systemd unit, 开机自启)
    ├── ryzenadj-tune.conf           (/etc/ryzenadj-tune.conf, 参数配置)
    └── cpu-boost-lock.service       (第 1 层 boost 锁 systemd unit, 开机自启)
```

## 安装

前置:已自行安装 ryzenadj 和 ryzen_smu(详见下方[前置依赖](#前置依赖)章节)。

```bash
bash install.sh
```

安装后重启 GNOME Shell(X11:`Alt+F2` → `r`;Wayland:注销重登),然后启用扩展(`gnome-extensions enable cpu-control@miskin`)。**最后通过扩展下拉菜单按需开启** boost 锁或调优档位——安装本身不会改变任何系统状态。

> **安装不会修改任何运行状态。** boost 开关、CPU 频率、功耗/温度墙均保持当前值;两个 systemd service 都只是就位,不启动、不开机自启。是否启用、何时启用,完全由你通过扩展菜单决定(点档位/锁定即激活对应 service)。

## 卸载

```bash
bash install.sh --uninstall
```

(ryzenadj 二进制默认保留,因为是共用工具)

## 手动调参

配置文件 `/etc/ryzenadj-tune.conf` 可手动编辑,改后重启守护进程生效:

```bash
sudo systemctl restart ryzenadj-tune.service
```

格式(单位:mW / °C):

```bash
ARGS="--tctl-temp=90 --fast-limit=45000"
INTERVAL=30
```

手动测试守护脚本(应用一次):

```bash
sudo /usr/libexec/ryzenadj-tune --once
cat /run/ryzenadj-tune.status   # 扩展读取的状态文件
```

## 前置依赖

**安装本扩展前,请自行安装以下两个组件**(本扩展不会自动安装它们):

| 依赖 | 说明 | 上游地址 |
|---|---|---|
| **ryzenadj** | Ryzen 电源管理调优工具(CLI)。需自行构建。install.sh 会把构建产物加固安装成 root 拥有副本。 | [FlyGoat/RyzenAdj](https://github.com/FlyGoat/RyzenAdj) |
| **ryzen_smu** | 内核模块,ryzenadj 通过它访问 SMU。DKMS 安装,需配置开机自动加载。 | [amkillam/ryzen_smu](https://github.com/amkillam/ryzen_smu) |

请按上游仓库的安装文档操作。装好后用这条命令验证:

```bash
sudo ryzenadj -i
```

能看到 `detected compatible ryzen_smu kernel module` 和完整的 PM Table,说明依赖就绪,可以跑 `bash install.sh` 了。

**其他环境要求:**

- DKMS + linux-headers(ryzen_smu 每次内核更新需重新编译,DKMS 自动处理)
- GNOME Shell 45/46
- polkit(默认已装)
- `cpu-boost-lock.service` —— 已随本扩展打包,install.sh 自动安装

> **其他 APU 用户注意:** 本扩展的默认参数(温度/功耗档位)专为 4800H(35W TDP)调校。如果你的 APU 不同(Cezanne/Rembrandt/Phoenix 等),请编辑 `/etc/ryzenadj-tune.conf` 自行调整参数,否则可能限频过度或无效果。

## 已知限制

- 锁定/解锁按钮的 hover 高亮在鼠标移出后偶有残留——GNOME 46 + Clutter 在该 widget 组合下的已知 quirk,不影响功能。
- ryzenadj 不能关 boost(那是 sysfs 独占能力),所以第 1 层不可被第 2 层替代。
- 不使用 OC 锁压 / Curve Optimiser 负压——对 L3 低频低压失稳是加剧方向,风险不可接受。
- 内核更新后 ryzen_smu 需重新编译(DKMS 自动),若失败调优层会无法工作,见 `journalctl -u ryzenadj-tune`。
- Secure Boot 开启时 ryzen_smu 模块需签名 enrolled,建议关闭 Secure Boot。

## 许可证

MIT,见 [LICENSE](LICENSE)。
