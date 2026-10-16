@echo off
set "FLAG=%TEMP%\psjsx_STOP.txt"
if exist "%FLAG%" goto ALREADY
echo STOP > "%FLAG%"
if exist "%FLAG%" goto OK
echo [失败] 没能建立停止信号文件，请检查 TEMP 目录是否可写。
goto END
:ALREADY
echo [提示] 停止信号已经存在：%FLAG%
echo        说明脚本还没跑到检查点，或者在收尾，稍等一下。
goto END
:OK
echo [成功] 停止信号已建立：%FLAG%
echo        脚本会在处理完当前这一层之后停下来，并正常写出日志。
echo        这个窗口可以关掉了。
:END
timeout /t 4 >nul 2>&1
exit /b 0
