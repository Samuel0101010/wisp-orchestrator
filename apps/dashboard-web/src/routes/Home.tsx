import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

export function Home() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Welcome</CardTitle>
        <CardDescription>Select or create a project to get started.</CardDescription>
      </CardHeader>
      <CardContent />
    </Card>
  );
}
