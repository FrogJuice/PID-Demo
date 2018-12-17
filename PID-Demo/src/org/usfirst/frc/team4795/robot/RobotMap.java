package org.usfirst.frc.team4795.robot;

public enum RobotMap {
    // CAN motor controllers
    LEFT_MOTOR_1(5), LEFT_MOTOR_2(3), RIGHT_MOTOR_1(6), RIGHT_MOTOR_2(2), ARM_MOTOR(1), PCM(0);

    public final int value;

    RobotMap(int value) {
        this.value = value;
    }
}
