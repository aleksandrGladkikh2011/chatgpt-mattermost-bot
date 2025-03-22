declare module 'node-cron' {
    function schedule(expression: string, task: () => void): void;
    export default { schedule };
} 