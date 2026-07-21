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
│  收紧 温度墙 / 瞬时电流 / 瞬时功耗                    │
│  → 降低电压波动幅度, 给 L3 缺陷更多安全余量            │
│  → 由 ryzenadj-tune.service 守护 (30s 重应用)         │
└──────────────────────────────────────────────────────┘
```

**为什么需要两层:** `boost=0`(关睿频)是 sysfs 独占能力,ryzenadj 没有等价开关;ryzenadj 调的是 SMU 层电压/电流/功耗/温度,sysfs 管不了。两者正交,缺一不可。

**为什么第 2 层需要守护进程:** ryzenadj 设置是易失的——SMU 重置、挂起恢复、固件电源管理都会覆盖它。守护进程每 30 秒重新应用(参考官方 `readjust.py`)。

## 预设档位(扩展菜单)

| 档位 | 温度墙 (°C) | 瞬时电流 EDC (A) | 瞬时功耗 PPT FAST (W) | 定位 |
|---|---|---|---|---|
| 🟢 节能 | 80 | 80 | 38 | 最凉,负载限频明显,适合轻办公/续航 |
| ⚖️ 均衡 | 90 | 85 | 45 | 日常默认 |
| 🚀 性能 | 95 | 90 | 55 | 接近出厂略收紧,重负载余量足 |
| ⏹️ 关闭调优 | — | — | — | 停守护进程,回出厂 95°C/96A/60W |

三档均与 boost 锁层正交(boost 归 `lock`/`unlock` 管)。ryzenadj 参数单位:功率 mW、电流 mA、温度 °C。

## 顶栏与菜单

**顶栏实时显示**:`🔒 2.9G 65°`(锁定状态 + 频率 + 温度)

**下拉菜单**:
- 频率(实时)
- Boost 状态 + MCE 计数
- 自启锁定 service 状态
- 调优状态(档位 + 温度墙/EDC/功耗的 限制值/实测值 + 守护状态)
- 🔒 **锁定 boost** / 🔓 **解锁 boost**(第 1 层)
- 🟢 **节能** / ⚖️ **均衡** / 🚀 **性能** / ⏹️ **关闭调优**(第 2 层)

所有操作通过 **polkit 提权**(GNOME 原生密码框),`auth_admin_keep`:输一次密码 5 分钟内免重复弹窗。

## 背景

4800H(Zen2)存在硬件级缺陷:高负载→低负载切换时,电压下调速度快于频率下降,导致 L3 缓存在低频低压区出现 MCE,累积触发系统死锁。

实测验证:`boost=0`(关闭睿频)+ 锁频率 2.9GHz 能彻底消除 MCE;叠加 ryzenadj 收紧温度/电流/功耗可进一步降低电压波动。本扩展把这套方案做成顶栏一键控制。

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

前置:已构建 ryzenadj 并安装 ryzen_smu 内核模块(详见下方[依赖安装](#依赖安装从零开始)章节)。

```bash
bash install.sh
```

安装后重启 GNOME Shell(X11:`Alt+F2` → `r`;Wayland:注销重登)。

安装脚本会做 9 步:扩展 → cpuctrl helper → polkit 策略 → **加固 ryzenadj 二进制**(装成 root 拥有副本,避免提权隐患)→ 守护脚本 → 配置文件(已有则备份不覆盖)→ systemd unit(调优 + boost 锁)→ 启动调优层。

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

格式(单位:mW / mA / °C):

```bash
ARGS="--tctl-temp=90 --vrmmax-current=85000 --fast-limit=45000"
INTERVAL=30
```

手动测试守护脚本(应用一次):

```bash
sudo /usr/libexec/ryzenadj-tune --once
cat /run/ryzenadj-tune.status   # 扩展读取的状态文件
```

## 依赖安装(从零开始)

本扩展需要两个外部组件:**ryzenadj**(调优工具)和 **ryzen_smu**(内核模块)。下面是从零安装的完整步骤。

### 1. 构建并安装 ryzenadj

```bash
# 安装编译依赖 (Ubuntu/Debian)
sudo apt install build-essential cmake libpci-dev git

# 克隆并编译
git clone https://github.com/FlyGoat/RyzenAdj.git ~/RyzenAdj
cd ~/RyzenAdj
cmake -B build -DCMAKE_BUILD_TYPE=Release
make -C build -j"$(nproc)"

# install.sh 会把构建产物加固安装到 /usr/local/bin/ryzenadj (root 拥有)
# 所以这里只需保留构建产物, 不用手动 install
```

### 2. 安装 ryzen_smu 内核模块(DKMS)

ryzenadj 通过 ryzen_smu 内核模块访问 SMU(系统管理单元)。

```bash
# 安装 DKMS 依赖
sudo apt install dkms linux-headers-$(uname -r)

# 克隆并安装 (amkillam 的活跃维护分支)
git clone https://github.com/amkillam/ryzen_smu.git
cd ryzen_smu
sudo make dkms-install

# 立即加载模块
sudo modprobe ryzen_smu

# 验证 (应显示 detected compatible ryzen_smu kernel module)
sudo ryzenadj -i
```

### 3. 配置开机自动加载 ryzen_smu

```bash
echo "ryzen_smu" | sudo tee /etc/modules-load.d/ryzen_smu.conf
```

### 验证全部就绪

```bash
# 应显示 SMU 信息 + PM Table (不报错)
sudo ryzenadj -i
```

如果看到 `detected compatible ryzen_smu kernel module` 和完整的 PM Table,说明依赖全部就绪,可以跑 `bash install.sh` 了。

> **其他 APU 用户注意:** 本扩展的默认参数(温度/电流/功耗档位)专为 4800H(35W TDP)调校。如果你的 APU 不同(Cezanne/Rembrandt/Phoenix 等),请编辑 `/etc/ryzenadj-tune.conf` 自行调整参数,否则可能限频过度或无效果。

## 前置依赖(汇总)

- **ryzenadj**(按上方步骤构建;install.sh 会加固安装成 root 副本)
- **ryzen_smu 内核模块**(DKMS,按上方步骤安装 + 配置开机加载)
- **DKMS + linux-headers**(ryzen_smu 每次内核更新需重新编译,DKMS 自动处理)
- GNOME Shell 45/46
- polkit(默认已装)
- `cpu-boost-lock.service` —— **已随本扩展打包**,install.sh 自动安装

## 已知限制

- 锁定/解锁按钮的 hover 高亮在鼠标移出后偶有残留——GNOME 46 + Clutter 在该 widget 组合下的已知 quirk,不影响功能。
- ryzenadj 不能关 boost(那是 sysfs 独占能力),所以第 1 层不可被第 2 层替代。
- 不使用 OC 锁压 / Curve Optimiser 负压——对 L3 低频低压失稳是加剧方向,风险不可接受。
- 内核更新后 ryzen_smu 需重新编译(DKMS 自动),若失败调优层会无法工作,见 `journalctl -u ryzenadj-tune`。
- Secure Boot 开启时 ryzen_smu 模块需签名 enrolled,建议关闭 Secure Boot。

## 许可证

MIT,见 [LICENSE](LICENSE)。
