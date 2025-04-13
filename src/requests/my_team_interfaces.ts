export interface CalendarResponse {
    data: {
      lang: string;
      search: {
        placeholder: string;
        code: string;
      };
      filters: any[]; // если появятся данные — можно уточнить
      items: CalendarItem[];
    };
}
  
interface CalendarItem {
    user: UserInfo;
    absences: Absence[];
}
  
interface UserInfo {
    id: number;
    name: string;
    avatar: string;
    position: string;
    department: string;
}
  
interface Absence {
    date: string; // "28.04.2025"
    count: string; // "1" – строка, не число
    type: AbsenceType;
    status: AbsenceStatus;
    requestId: number;
    canShow: boolean;
}

interface AbsenceType {
    id: number;
    name: string;
    icon: string;
    color: string; // hex
    unit: 'days' | 'hours' | string; // уточнить, если есть другие единицы
}
  
interface AbsenceStatus {
    id: number;
    code: 'open' | 'process' | 'approve' | string; // уточнить, если есть другие статусы
    name: string;
}
  
export interface SimplifiedAbsence {
    date: string;
    count: number;
    typeName: string;
    statusName: string;
}
  
export interface SimplifiedItem {
    user: string;
    absences: SimplifiedAbsence[];
}